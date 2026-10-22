import type {
  ContentMedia,
  ContentView,
  ListingContentResponse,
  PortalReadinessView,
} from "@agentsales/api/contracts";
import { LISTING_PLATFORMS, type ListingPlatform, PLATFORM_TEXT } from "@agentsales/core";
import { type KeyboardEvent, useRef, useState } from "react";
import { PublicationsPanel } from "../publications/PublicationsPanel.js";
import { portalIssuesHint, ReadinessIssueList } from "../ReadinessIssueList.js";
import { Button } from "../ui/Button.js";
import { ApprovableText, type EditContext } from "./ApprovableText.js";
import { captionPreview } from "./caption.js";
import { MarketplacePanel } from "./MarketplacePanel.js";

/** El caption de Instagram con "ver más", como en la app: primero solo el comienzo. */
function Caption({ content }: { content: ContentView }) {
  const [expanded, setExpanded] = useState(false);
  const { full, preview } = captionPreview(content);
  return (
    <section aria-label="Caption de Instagram" className="mt-3 text-sm">
      <p className="whitespace-pre-line">{preview !== null && !expanded ? preview : full}</p>
      {preview !== null && (
        <Button
          variant="link"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-sm"
        >
          {expanded ? "ver menos" : "ver más"}
        </Button>
      )}
    </section>
  );
}

function InstagramPanel({
  content,
  carousel,
  reel,
  edit,
}: {
  content: ContentView | undefined;
  carousel: ContentMedia[];
  reel: ContentMedia | null;
  edit: EditContext;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="text-sm font-semibold text-fg">Carrusel ({carousel.length})</h3>
        {carousel.length === 0 ? (
          <p className="mt-2 text-sm text-fg-subtle">Sin imágenes todavía.</p>
        ) : (
          <ul
            aria-label="Carrusel de Instagram"
            // Desplazable también con el teclado (flechas, una vez enfocado).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: una lista que se desplaza debe poder enfocarse.
            tabIndex={0}
            className="mt-2 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2"
          >
            {carousel.map((item, index) => (
              <li key={item.id} className="w-64 flex-none snap-start">
                <img
                  src={item.url}
                  alt={`Imagen ${index + 1} de ${carousel.length} del carrusel`}
                  loading="lazy"
                  className="aspect-[4/5] w-full rounded-md bg-slate-100 object-cover"
                />
              </li>
            ))}
          </ul>
        )}
        <h3 className="mt-4 text-sm font-semibold text-fg">Reel</h3>
        {reel === null ? (
          <p className="mt-2 text-sm text-fg-subtle">Sin reel (la propiedad no tiene video).</p>
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: el texto del reel va dibujado en el video.
          <video
            src={reel.url}
            controls
            preload="metadata"
            aria-label="Reel de Instagram"
            className="mt-2 aspect-[9/16] w-48 rounded-md bg-black"
          />
        )}
      </div>
      <div>
        {content === undefined ? (
          <p className="text-sm text-fg-subtle">Sin texto todavía.</p>
        ) : (
          <ApprovableText content={content} edit={edit}>
            <Caption content={content} />
          </ApprovableText>
        )}
        <PublicationsPanel
          platform="instagram"
          listingId={edit.listingId}
          listingStatus={edit.listingStatus}
          content={content}
          publications={edit.publications.filter((p) => p.platform === "instagram")}
          publishMode={edit.publishMode}
          runActive={edit.runActive}
        />
      </div>
    </div>
  );
}

/**
 * Lo que le falta al aviso para Portal (`portalReadiness`, spec F4 §4.5 y §4.12), solo en su
 * pestaña: se aprueba igual, pero Publicar lo exige.
 */
function PortalReadiness({ readiness }: { readiness: PortalReadinessView }) {
  if (readiness.ready) {
    return (
      <p className="mb-3 text-sm text-success-800">
        El aviso tiene lo que pide Portal Inmobiliario.
      </p>
    );
  }
  return (
    <section
      aria-label="Lo que falta para Portal"
      className="mb-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
    >
      <p className="font-semibold text-warning-800">Para publicar en Portal falta:</p>
      <ReadinessIssueList issues={readiness.issues} className="text-warning-800" />
      <p className="mt-1 text-xs text-warning-800">{portalIssuesHint(readiness.issues)}</p>
    </section>
  );
}

function ListingPanel({
  platform,
  content,
  photos,
  edit,
  portalReadiness,
}: {
  platform: ListingPlatform;
  content: ContentView | undefined;
  photos: ContentMedia[];
  edit: EditContext;
  portalReadiness: PortalReadinessView;
}) {
  const portal = platform === "portal_inmobiliario";
  return (
    <div>
      {portal && <PortalReadiness readiness={portalReadiness} />}
      {content === undefined ? (
        <p className="text-sm text-fg-subtle">Sin texto todavía.</p>
      ) : (
        <ApprovableText content={content} edit={edit}>
          <h3 className="mt-2 text-lg font-semibold">{content.title}</h3>
          <p className="mt-2 whitespace-pre-line text-sm">{content.body}</p>
        </ApprovableText>
      )}
      <h3 className="mt-4 text-sm font-semibold text-fg">Fotos ({photos.length})</h3>
      <ul className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        {photos.map((item, index) => (
          <li key={item.id}>
            <img
              src={item.url}
              alt={`Foto ${index + 1} para ${PLATFORM_TEXT[platform]}`}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-md bg-slate-100 object-cover"
            />
          </li>
        ))}
      </ul>
      {portal && (
        <PublicationsPanel
          platform={platform}
          listingId={edit.listingId}
          listingStatus={edit.listingStatus}
          content={content}
          publications={edit.publications.filter((p) => p.platform === platform)}
          publishMode={edit.publishMode}
          runActive={edit.runActive}
          readiness={portalReadiness}
        />
      )}
    </div>
  );
}

/**
 * Pestañas por canal: lo que se publicaría en cada uno. Siguen el patrón de pestañas de ARIA: solo
 * la activa se enfoca con Tab, y las flechas, Inicio y Fin cambian de pestaña.
 */
export function Preview({ content, ...edit }: { content: ListingContentResponse } & EditContext) {
  const [platform, setPlatform] = useState<ListingPlatform>("instagram");
  const tabs = useRef(new Map<ListingPlatform, HTMLButtonElement>());
  const textOf = (target: ListingPlatform) =>
    content.contents.find((item) => item.platform === target);
  const hasErrors = (target: ListingPlatform) =>
    textOf(target)?.checks.some((check) => check.severity === "error") ?? false;

  const select = (target: ListingPlatform) => {
    setPlatform(target);
    tabs.current.get(target)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const index = LISTING_PLATFORMS.indexOf(platform);
    const last = LISTING_PLATFORMS.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(LISTING_PLATFORMS[next] ?? platform);
  };

  return (
    <div className="mt-4">
      <div
        role="tablist"
        aria-label="Canales"
        onKeyDown={onKeyDown}
        className="flex gap-1 border-b border-line"
      >
        {LISTING_PLATFORMS.map((target) => {
          const selected = platform === target;
          return (
            <button
              key={target}
              ref={(element) => {
                if (element) tabs.current.set(target, element);
              }}
              type="button"
              role="tab"
              id={`tab-${target}`}
              aria-selected={selected}
              aria-controls={`panel-${target}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setPlatform(target)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-brand-700 text-brand-800"
                  : "border-transparent text-fg-subtle hover:text-fg"
              }`}
            >
              {PLATFORM_TEXT[target]}
              {hasErrors(target) && (
                <span className="ml-1 text-danger-700" aria-hidden="true">
                  ●
                </span>
              )}
              {hasErrors(target) && <span className="sr-only"> (la revisión tiene errores)</span>}
            </button>
          );
        })}
      </div>
      {/* Los tres paneles quedan montados (solo se ve el elegido): un borrador abierto en un canal
          no se pierde ni se cruza con otro al cambiar de pestaña. */}
      {LISTING_PLATFORMS.map((target) => (
        <div
          key={target}
          role="tabpanel"
          id={`panel-${target}`}
          aria-labelledby={`tab-${target}`}
          hidden={platform !== target}
          className="pt-4"
        >
          {target === "instagram" ? (
            <InstagramPanel
              content={textOf("instagram")}
              carousel={content.carousel}
              reel={content.reel}
              edit={edit}
            />
          ) : target === "fb_marketplace" ? (
            <MarketplacePanel
              content={textOf(target)}
              photos={content.photos}
              edit={edit}
              readiness={content.marketplaceReadiness}
            />
          ) : (
            <ListingPanel
              platform={target}
              content={textOf(target)}
              photos={content.photos}
              edit={edit}
              portalReadiness={content.portalReadiness}
            />
          )}
        </div>
      ))}
    </div>
  );
}
