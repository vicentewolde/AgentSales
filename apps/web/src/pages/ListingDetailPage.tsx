import type { ListingDetailResponse } from "@agentsales/api/contracts";
import { describeAttributes, formatListingPrice, OPERATION_TEXT } from "@agentsales/core";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client.js";
import { ContentSection } from "../components/content/ContentSection.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { ListingActions } from "../components/listing/ListingActions.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { HomeIllustration } from "../components/ui/illustrations.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { cx } from "../components/ui/styles.js";
import { useListing } from "../queries/listings.js";

type Detail = ListingDetailResponse;

/** La portada primero y lo demás en su orden (F9.5-T26). */
const coverFirst = <T extends { isCover: boolean }>(media: readonly T[]): T[] => [
  ...media.filter((item) => item.isCover),
  ...media.filter((item) => !item.isCover),
];

/**
 * La forma de la galería según cuántos medios hay: uno a todo el ancho; de dos a cuatro, una fila
 * pareja; desde cinco, el mosaico con la portada en dos columnas y dos filas.
 */
function galleryLayout(count: number): { list: string; item: (index: number) => string } {
  if (count === 1) {
    return { list: "grid-cols-1", item: () => "aspect-[16/9]" };
  }
  if (count <= 4) {
    const columns = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[count];
    return { list: cx("grid-cols-2", columns), item: () => "aspect-[4/3]" };
  }
  return {
    list: "grid-cols-2 sm:grid-cols-4 sm:auto-rows-[11rem] lg:auto-rows-[13.5rem]",
    item: (index) => cx("aspect-[4/3] sm:aspect-auto", index === 0 && "col-span-2 sm:row-span-2"),
  };
}

/** La galería grande con que abre la ficha (F9.5-T26), como en un aviso de revista. */
function Gallery({ media: given, externalRef }: { media: Detail["media"]; externalRef: string }) {
  const media = coverFirst(given);
  const layout = galleryLayout(media.length);
  if (media.length === 0) {
    return (
      <div className="mt-3 flex flex-col items-center gap-3 rounded-3xl bg-sand px-6 py-10 text-center">
        <HomeIllustration className="w-36" />
        <p className="text-sm font-medium text-warning-800">
          Sin fotos ni videos. Agrégalos a su carpeta y vuelve a importar.
        </p>
      </div>
    );
  }
  return (
    <ul
      aria-label="Galería"
      className={cx("mt-3 grid gap-2 overflow-hidden rounded-3xl bg-sand sm:gap-3", layout.list)}
    >
      {media.map((item, index) => (
        <li key={item.id} className={cx("relative overflow-hidden", layout.item(index))}>
          {item.kind === "image" ? (
            <a href={item.url} target="_blank" rel="noreferrer" className="block h-full">
              <img
                // La miniatura JPEG si existe (desde F2-T12): los navegadores no muestran HEIC.
                src={item.thumbUrl ?? item.url}
                alt={`Foto ${index + 1} de ${externalRef}`}
                loading="lazy"
                className="h-full w-full object-cover transition duration-500 hover:scale-[1.02]"
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
              className="h-full w-full bg-fg object-contain"
            />
          )}
          {item.isCover && (
            <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-surface/95 px-2.5 py-1 text-xs font-semibold text-fg shadow-xs">
              Portada
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const PANEL = "rounded-3xl bg-surface p-6 shadow-card";

/** Las cifras destacadas de la ficha, de los campos de siempre (los de la planilla). */
const KEY_FIGURES = [
  { key: "dormitorios", one: "dormitorio", many: "dormitorios" },
  { key: "banos", one: "baño", many: "baños" },
  { key: "sup_util_m2", one: "útiles", many: "útiles", unit: " m²" },
  { key: "estacionamientos", one: "estacionamiento", many: "estacionamientos" },
] as const;

/**
 * Dormitorios, baños, m² útiles y estacionamientos en serif, como en la muestra (F9.5-T26): solo
 * los que la propiedad tiene con un número; nada se inventa.
 */
function KeyFigures({
  attributes,
  entries,
}: {
  attributes: Readonly<Record<string, unknown>>;
  entries: readonly { key: string; value: string; extra: boolean }[];
}) {
  const figures = KEY_FIGURES.flatMap((figure) => {
    const raw = attributes[figure.key];
    const entry = entries.find((candidate) => candidate.key === figure.key && !candidate.extra);
    if (typeof raw !== "number" || entry === undefined) return [];
    const unit = "unit" in figure ? figure.unit : "";
    return [
      { ...figure, text: `${entry.value}${unit}`, label: raw === 1 ? figure.one : figure.many },
    ];
  });
  if (figures.length === 0) return null;
  return (
    <ul aria-label="Cifras destacadas" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {figures.map((figure) => (
        <li key={figure.key} className="rounded-2xl bg-surface px-4 py-3.5 shadow-xs">
          <span className="block font-display text-[1.625rem] leading-tight text-fg tabular-nums">
            {figure.text}
          </span>
          <span className="text-sm text-fg-subtle">{figure.label}</span>
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
      <div className="mb-8">
        {/* La galería abre la ficha, antes del título: su rótulo no es un encabezado. */}
        <p className="text-sm font-medium text-fg-subtle">Fotos y videos ({media.length})</p>
        <Gallery media={media} externalRef={listing.externalRef} />
      </div>

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
            <p className="mt-2 font-display text-[2rem] leading-tight tabular-nums text-fg">
              {formatListingPrice(listing)}
            </p>
          </>
        }
      />
      <ListingActions id={listing.id} status={listing.status} />
      <KeyFigures attributes={listing.attributes} entries={attributes} />

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="datos" className={PANEL}>
          <h2 id="datos" className="text-xl font-semibold">
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

        <section aria-labelledby="atributos" className={PANEL}>
          <h2 id="atributos" className="text-xl font-semibold">
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
        musicTrackId={listing.musicTrackId}
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
    <section className="mx-auto max-w-6xl">
      <Link
        to="/propiedades"
        className="-ml-1 inline-flex min-h-11 items-center rounded-full px-1 text-sm font-medium text-fg-muted hover:text-fg"
      >
        ← Propiedades
      </Link>
      <div className="mt-2">
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
