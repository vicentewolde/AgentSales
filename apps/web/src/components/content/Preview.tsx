import type {
  ContentMedia,
  ContentView,
  ListingContentResponse,
  ListingPublicationView,
} from "@agentsales/api/contracts";
import {
  type ListingStatus,
  PLATFORM_TEXT,
  PLATFORMS,
  type Platform,
  type PublishMode,
} from "@agentsales/core";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { PublicationsPanel } from "../publications/PublicationsPanel.js";
import { editBlockedReason } from "../publications/publications.js";
import { ApprovalBar } from "./ApprovalBar.js";
import { captionPreview } from "./caption.js";
import { EditableText } from "./TextEditor.js";

/** El caption de Instagram con "ver más", como en la app: primero solo el comienzo. */
function Caption({ content }: { content: ContentView }) {
  const [expanded, setExpanded] = useState(false);
  const { full, preview } = captionPreview(content);
  return (
    <section aria-label="Caption de Instagram" className="mt-3 text-sm">
      <p className="whitespace-pre-line">{preview !== null && !expanded ? preview : full}</p>
      {preview !== null && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-sm font-medium text-slate-500 underline"
        >
          {expanded ? "ver menos" : "ver más"}
        </button>
      )}
    </section>
  );
}

/**
 * Lo que necesita un texto para poder editarse, aprobarse y publicarse (F3-T18): las publicaciones
 * del aviso, el modo de la API, el estado del aviso y si hay una preparación en curso.
 */
type EditContext = {
  listingId: string;
  lockReason: string | null;
  onReload: () => void;
  listingStatus: ListingStatus;
  /** Cualquier preparación en curso (también la de solo imágenes): bloquea aprobar y publicar. */
  runActive: boolean;
  publications: readonly ListingPublicationView[];
  publishMode: PublishMode | undefined;
};

/** El texto con su aprobación y su edición (bloqueada si tiene publicaciones activas). */
function ApprovableText({
  content,
  edit,
  children,
}: {
  content: ContentView;
  edit: EditContext;
  children: ReactNode;
}) {
  return (
    <>
      <ApprovalBar
        content={content}
        listingId={edit.listingId}
        listingStatus={edit.listingStatus}
        runActive={edit.runActive}
        publications={edit.publications}
      />
      <EditableText
        content={content}
        listingId={edit.listingId}
        lockReason={edit.lockReason ?? editBlockedReason(content, edit.publications)}
        onReload={edit.onReload}
      >
        {children}
      </EditableText>
    </>
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
        <h3 className="text-sm font-semibold text-slate-700">Carrusel ({carousel.length})</h3>
        {carousel.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Sin imágenes todavía.</p>
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
        <h3 className="mt-4 text-sm font-semibold text-slate-700">Reel</h3>
        {reel === null ? (
          <p className="mt-2 text-sm text-slate-500">Sin reel (la propiedad no tiene video).</p>
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
          <p className="text-sm text-slate-500">Sin texto todavía.</p>
        ) : (
          <ApprovableText content={content} edit={edit}>
            <Caption content={content} />
          </ApprovableText>
        )}
        <PublicationsPanel
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

function ListingPanel({
  platform,
  content,
  photos,
  edit,
}: {
  platform: Platform;
  content: ContentView | undefined;
  photos: ContentMedia[];
  edit: EditContext;
}) {
  return (
    <div>
      {content === undefined ? (
        <p className="text-sm text-slate-500">Sin texto todavía.</p>
      ) : (
        <ApprovableText content={content} edit={edit}>
          <h3 className="mt-2 text-lg font-semibold">{content.title}</h3>
          <p className="mt-2 whitespace-pre-line text-sm">{content.body}</p>
        </ApprovableText>
      )}
      <h3 className="mt-4 text-sm font-semibold text-slate-700">Fotos ({photos.length})</h3>
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
    </div>
  );
}

/**
 * Pestañas por canal: lo que se publicaría en cada uno. Siguen el patrón de pestañas de ARIA: solo
 * la activa se enfoca con Tab, y las flechas, Inicio y Fin cambian de pestaña.
 */
export function Preview({ content, ...edit }: { content: ListingContentResponse } & EditContext) {
  const [platform, setPlatform] = useState<Platform>("instagram");
  const tabs = useRef(new Map<Platform, HTMLButtonElement>());
  const textOf = (target: Platform) => content.contents.find((item) => item.platform === target);
  const hasErrors = (target: Platform) =>
    textOf(target)?.checks.some((check) => check.severity === "error") ?? false;

  const select = (target: Platform) => {
    setPlatform(target);
    tabs.current.get(target)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const index = PLATFORMS.indexOf(platform);
    const last = PLATFORMS.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(PLATFORMS[next] ?? platform);
  };

  return (
    <div className="mt-4">
      <div
        role="tablist"
        aria-label="Canales"
        onKeyDown={onKeyDown}
        className="flex gap-1 border-b border-slate-200"
      >
        {PLATFORMS.map((target) => {
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
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                selected
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {PLATFORM_TEXT[target]}
              {hasErrors(target) && (
                <span className="ml-1 text-red-600" aria-hidden="true">
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
      {PLATFORMS.map((target) => (
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
          ) : (
            <ListingPanel
              platform={target}
              content={textOf(target)}
              photos={content.photos}
              edit={edit}
            />
          )}
        </div>
      ))}
    </div>
  );
}
