import type { ListingDetailResponse } from "@agentsales/api/contracts";
import { describeAttributes, formatListingPrice, OPERATION_TEXT } from "@agentsales/core";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client.js";
import { ContentSection } from "../components/content/ContentSection.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { ListingActions } from "../components/listing/ListingActions.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useListing } from "../queries/listings.js";

type Detail = ListingDetailResponse;

function Gallery({ media, externalRef }: { media: Detail["media"]; externalRef: string }) {
  if (media.length === 0) {
    return (
      <p className="mt-2 text-sm text-warning-700">
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
                // La miniatura JPEG si existe (desde F2-T12): los navegadores no muestran HEIC.
                src={item.thumbUrl ?? item.url}
                alt={`Foto ${index + 1} de ${externalRef}`}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
            </a>
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: videos del corredor, sin subtítulos en el MVP.
            <video
              src={item.url}
              poster={item.thumbUrl ?? undefined}
              controls
              preload="metadata"
              aria-label={`Video ${index + 1} de ${externalRef}`}
              className="aspect-[4/3] w-full bg-black object-contain"
            />
          )}
          {item.isCover && (
            <span className="absolute top-2 left-2 rounded-md bg-brand-900/80 px-2 py-0.5 text-xs font-medium text-white">
              Portada
            </span>
          )}
        </li>
      ))}
    </ul>
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
      <PageHeader
        title={
          <>
            {title}
            {listing.comuna ? ` · ${listing.comuna}` : ""}
          </>
        }
        meta={<StatusBadge status={listing.status} />}
        description={
          <>
            <p className="font-medium tabular-nums text-fg-subtle">{listing.externalRef}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-fg">
              {formatListingPrice(listing)}
            </p>
          </>
        }
      />
      <ListingActions id={listing.id} status={listing.status} />

      <div className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 className="text-lg font-semibold">Fotos y videos ({media.length})</h2>
        <Gallery media={media} externalRef={listing.externalRef} />
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section
          aria-labelledby="datos"
          className="rounded-xl border border-line bg-surface p-5 shadow-xs"
        >
          <h2 id="datos" className="text-lg font-semibold">
            Datos
          </h2>
          <dl className="mt-2 space-y-2 text-sm">
            <div>
              <dt className="font-medium text-fg-muted">Dirección</dt>
              <dd>
                {address || "—"}
                {!listing.showExactAddress && (
                  <span className="block text-xs text-fg-subtle">
                    No se publica la dirección exacta.
                  </span>
                )}
              </dd>
            </div>
            {listing.highlights && (
              <div>
                <dt className="font-medium text-fg-muted">Destacados</dt>
                <dd>{listing.highlights}</dd>
              </div>
            )}
            {listing.internalNotes && (
              <div>
                <dt className="font-medium text-fg-muted">Notas internas</dt>
                <dd>
                  {listing.internalNotes}
                  <span className="block text-xs text-fg-subtle">
                    Solo para ti: no se publican.
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section
          aria-labelledby="atributos"
          className="rounded-xl border border-line bg-surface p-5 shadow-xs"
        >
          <h2 id="atributos" className="text-lg font-semibold">
            Atributos
          </h2>
          {attributes.length === 0 ? (
            <p className="mt-2 text-sm text-fg-subtle">Sin atributos.</p>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {attributes.map((entry) => (
                <div key={`${entry.extra}-${entry.key}`} className="contents">
                  <dt className="font-medium text-fg-muted">
                    {entry.label}
                    {entry.extra && <span className="ml-1 text-xs text-fg-subtle">(extra)</span>}
                  </dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>

      <ContentSection
        listingId={listing.id}
        listingStatus={listing.status}
        listingPrice={listing}
        brokerId={listing.brokerId}
      />
    </>
  );
}

/**
 * Detalle de una propiedad: galería, datos, atributos y cambio de estado (spec F1-T13), y su
 * contenido por canal (F2-T14).
 */
export function ListingDetailPage() {
  const { id = "" } = useParams();
  const detail = useListing(id);
  const notFound =
    detail.error instanceof ApiError &&
    (detail.error.code === "LISTING_NOT_FOUND" || detail.error.code === "REQUEST_INVALID");

  return (
    <section className="mx-auto max-w-5xl">
      <Link to="/propiedades" className="text-sm font-medium text-fg-muted hover:text-fg">
        ← Propiedades
      </Link>
      <div className="mt-3">
        {detail.isPending && <p className="text-fg-muted">Cargando la propiedad…</p>}
        {notFound && (
          <p role="alert" className="text-fg-muted">
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
