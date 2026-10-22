import type {
  ContentMedia,
  ContentView,
  ListingContentResponse,
  PortalReadinessView,
} from "@agentsales/api/contracts";
import {
  formatListingPrice,
  LISTING_PLATFORMS,
  type ListingPlatform,
  PLATFORM_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import { type KeyboardEvent, useRef, useState } from "react";
import { useAccountName } from "../preview/account-name.js";
import { InstagramPostPreview, InstagramReelPreview } from "../preview/InstagramPreview.js";
import { PortalPreview } from "../preview/PortalPreview.js";
import type { PreviewImage, PreviewText } from "../preview/preview.js";
import { PublicationsPanel } from "../publications/PublicationsPanel.js";
import { portalIssuesHint, ReadinessIssueList } from "../ReadinessIssueList.js";
import { ApprovableText, type EditContext } from "./ApprovableText.js";
import { MarketplacePanel } from "./MarketplacePanel.js";

/** Las fotos de un aviso como las usa la vista previa. */
const previewImages = (media: readonly ContentMedia[]): PreviewImage[] =>
  media.map((item) => ({ id: item.id, src: item.url }));

/**
 * El texto que muestra la vista previa: el borrador del editor mientras se edita (F9.5-T07), si no
 * el guardado. `draft` dice cuál es.
 */
function useShownText(content: ContentView | undefined) {
  const [draft, setDraft] = useState<PreviewText | null>(null);
  const text: PreviewText | null = draft ?? content ?? null;
  return { text, draft: draft !== null, onDraft: setDraft };
}

function InstagramPanel({
  content,
  carousel,
  reel,
  edit,
  brokerId,
}: {
  content: ContentView | undefined;
  carousel: ContentMedia[];
  reel: ContentMedia | null;
  edit: EditContext;
  brokerId: string | undefined;
}) {
  const accountName = useAccountName(brokerId, "instagram");
  const { text, draft, onDraft } = useShownText(content);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <h3 className="text-sm font-semibold text-fg first-letter:uppercase">
          {/* Una sola imagen sale como imagen suelta, no como carrusel (F9.5-T02). */}
          {publicationFormatText("instagram", "post", carousel.length)} ({carousel.length})
        </h3>
        <InstagramPostPreview
          label="Vista previa de Instagram"
          accountName={accountName}
          images={previewImages(carousel)}
          text={text}
          draft={draft}
        />
        <h3 className="text-sm font-semibold text-fg">Reel</h3>
        {reel === null ? (
          <p className="text-sm text-fg-subtle">Sin reel (la propiedad no tiene video).</p>
        ) : (
          <InstagramReelPreview
            label="Vista previa del reel de Instagram"
            accountName={accountName}
            video={{ id: reel.id, src: reel.url, poster: null }}
            text={text}
            draft={draft}
          />
        )}
      </div>
      <div className="min-w-0">
        {content === undefined ? (
          <p className="text-sm text-fg-subtle">Sin texto todavía.</p>
        ) : (
          <ApprovableText content={content} edit={edit} onDraft={onDraft} />
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
  const { text, draft, onDraft } = useShownText(content);
  return (
    <div>
      {portal && <PortalReadiness readiness={portalReadiness} />}
      {content === undefined ? (
        <p className="text-sm text-fg-subtle">Sin texto todavía.</p>
      ) : (
        <ApprovableText content={content} edit={edit} onDraft={onDraft} />
      )}
      <h3 className="mt-4 mb-2 text-sm font-semibold text-fg">Fotos ({photos.length})</h3>
      <PortalPreview
        label={`Vista previa de ${PLATFORM_TEXT[platform]}`}
        title={text?.title ?? null}
        price={edit.listingPrice === null ? null : formatListingPrice(edit.listingPrice)}
        photos={previewImages(photos)}
        description={text?.body ?? null}
        draft={draft}
      />
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
export function Preview({
  content,
  brokerId,
  ...edit
}: {
  content: ListingContentResponse;
  /** El corredor del aviso: el nombre de su cuenta de Instagram en la vista previa. */
  brokerId?: string | undefined;
} & EditContext) {
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
              brokerId={brokerId}
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
