import type { ListingDetailResponse } from "@agentsales/api/contracts";
import {
  describeAttributes,
  formatListingPrice,
  LISTING_MANUAL_TRANSITIONS,
} from "@agentsales/core";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { OPERATION_TEXT, STATUS_ACTION_TEXT } from "../labels.js";
import { useChangeListingStatus, useListing } from "../queries/listings.js";

type Detail = ListingDetailResponse;

function Gallery({ media, externalRef }: { media: Detail["media"]; externalRef: string }) {
  if (media.length === 0) {
    return (
      <p className="mt-2 text-sm text-amber-700">
        Sin fotos ni videos. Agrégalos a su carpeta y vuelve a importar.
      </p>
    );
  }
  return (
    <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
      {media.map((item, index) => (
        <li key={item.id} className="relative overflow-hidden rounded-lg bg-slate-100">
          {item.kind === "image" ? (
            <a href={item.url} target="_blank" rel="noreferrer">
              <img
                src={item.url}
                alt={`Foto ${index + 1} de ${externalRef}`}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
            </a>
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: videos del corredor, sin subtítulos en el MVP.
            <video
              src={item.url}
              controls
              preload="metadata"
              aria-label={`Video ${index + 1} de ${externalRef}`}
              className="aspect-[4/3] w-full bg-black object-contain"
            />
          )}
          {item.isCover && (
            <span className="absolute top-2 left-2 rounded bg-slate-900/80 px-2 py-0.5 text-xs font-medium text-white">
              Portada
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function StatusActions({ id, status }: { id: string; status: Detail["listing"]["status"] }) {
  const change = useChangeListingStatus(id);
  const targets = LISTING_MANUAL_TRANSITIONS[status].filter(
    (target): target is keyof typeof STATUS_ACTION_TEXT => target in STATUS_ACTION_TEXT,
  );
  if (targets.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {targets.map((target) => (
          <button
            key={target}
            type="button"
            disabled={change.isPending}
            onClick={() => change.mutate(target)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
          >
            {STATUS_ACTION_TEXT[target]}
          </button>
        ))}
      </div>
      {change.error && <ErrorAlert error={change.error} />}
    </div>
  );
}

function DetailView({ detail }: { detail: Detail }) {
  const { listing, media, fields } = detail;
  const title = [
    listing.propertyType ?? "Propiedad",
    listing.operation ? `en ${OPERATION_TEXT[listing.operation].toLowerCase()}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const address = [listing.address, listing.unitNumber, listing.comuna, listing.region]
    .filter(Boolean)
    .join(", ");
  const attributes = describeAttributes(listing.attributes, fields);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{listing.externalRef}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {title}
            {listing.comuna ? ` · ${listing.comuna}` : ""}
          </h1>
          <p className="mt-1 text-xl font-semibold">{formatListingPrice(listing)}</p>
        </div>
        <StatusBadge status={listing.status} />
      </div>
      <StatusActions id={listing.id} status={listing.status} />

      <h2 className="mt-8 text-lg font-semibold">Fotos y videos ({media.length})</h2>
      <Gallery media={media} externalRef={listing.externalRef} />

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="datos">
          <h2 id="datos" className="text-lg font-semibold">
            Datos
          </h2>
          <dl className="mt-2 space-y-2 text-sm">
            <div>
              <dt className="font-medium text-slate-600">Dirección</dt>
              <dd>
                {address || "—"}
                {!listing.showExactAddress && (
                  <span className="block text-xs text-slate-500">
                    No se publica: en los avisos va solo la comuna.
                  </span>
                )}
              </dd>
            </div>
            {listing.highlights && (
              <div>
                <dt className="font-medium text-slate-600">Destacados</dt>
                <dd>{listing.highlights}</dd>
              </div>
            )}
            {listing.internalNotes && (
              <div>
                <dt className="font-medium text-slate-600">Notas internas</dt>
                <dd>
                  {listing.internalNotes}
                  <span className="block text-xs text-slate-500">
                    Solo para ti: no se publican.
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section aria-labelledby="atributos">
          <h2 id="atributos" className="text-lg font-semibold">
            Atributos
          </h2>
          {attributes.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Sin atributos.</p>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {attributes.map((entry) => (
                <div key={`${entry.extra}-${entry.key}`} className="contents">
                  <dt className="font-medium text-slate-600">
                    {entry.label}
                    {entry.extra && <span className="ml-1 text-xs text-slate-400">(extra)</span>}
                  </dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </>
  );
}

/** Detalle de una propiedad: galería, datos, atributos y cambio de estado (spec F1-T13). */
export function ListingDetailPage() {
  const { id = "" } = useParams();
  const detail = useListing(id);
  const notFound =
    detail.error instanceof ApiError &&
    (detail.error.code === "LISTING_NOT_FOUND" || detail.error.code === "REQUEST_INVALID");

  return (
    <section className="mx-auto max-w-5xl">
      <Link to="/propiedades" className="text-sm text-slate-600 underline">
        ← Propiedades
      </Link>
      <div className="mt-3">
        {detail.isPending && <p className="text-slate-600">Cargando la propiedad…</p>}
        {notFound && (
          <p role="alert" className="text-slate-700">
            Esta propiedad no existe.
          </p>
        )}
        {detail.error && !notFound && (
          <ErrorAlert
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        )}
        {detail.data && <DetailView detail={detail.data} />}
      </div>
    </section>
  );
}
