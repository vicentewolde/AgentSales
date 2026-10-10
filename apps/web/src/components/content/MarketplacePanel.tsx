import type {
  ContentMedia,
  ContentView,
  ListingPublicationView,
  ReadinessView,
} from "@agentsales/api/contracts";
import { useState } from "react";
import { PublicationsPanel } from "../publications/PublicationsPanel.js";
import { safeExternalUrl } from "../publications/publications.js";
import { marketplaceIssuesHint, ReadinessIssueList } from "../ReadinessIssueList.js";
import { ApprovableText, type EditContext } from "./ApprovableText.js";
import { type ListingPrice, planBPrice } from "./marketplace.js";

const MARKETPLACE = "fb_marketplace";

/**
 * Lo que le falta al aviso para el formulario de Marketplace (`marketplaceReadiness`, spec F5 §4.6
 * y §4.12), solo en su pestaña: se aprueba igual, pero Publicar lo exige.
 */
function MarketplaceReadiness({ readiness }: { readiness: ReadinessView }) {
  if (readiness.ready) {
    return (
      <p className="mb-3 text-sm text-emerald-800">
        El aviso tiene lo que pide el formulario de Marketplace.
      </p>
    );
  }
  const hint = marketplaceIssuesHint(readiness.issues);
  return (
    <section
      aria-label="Lo que falta para Marketplace"
      className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <p className="font-semibold text-amber-900">Para publicar en Marketplace falta:</p>
      <ReadinessIssueList issues={readiness.issues} className="text-amber-900" />
      {hint !== "" && <p className="mt-1 text-xs text-amber-800">{hint}</p>}
    </section>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** Copia un texto al portapapeles y dice si pudo (`label` nombra el botón para el lector). */
function CopyButton({ text, label, children }: { text: string; label: string; children: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={label}
        onClick={() => void copy()}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium"
      >
        {children}
      </button>
      <span role="status" className="text-xs text-slate-600">
        {state === "copied" && "Copiado"}
        {state === "failed" && "No se pudo copiar: selecciónalo a mano"}
      </span>
    </span>
  );
}

/**
 * Plan B (spec F5 §4.12, D13): publicar a mano en Facebook si el formulario cambió o el robot no
 * sirve. Copiar el título y la descripción aprobados, el precio y abrir cada foto para bajarla.
 */
function PlanB({
  content,
  photos,
  publications,
  listingPrice,
}: {
  content: ContentView | undefined;
  photos: ContentMedia[];
  publications: readonly ListingPublicationView[];
  listingPrice: ListingPrice | null;
}) {
  return (
    <details className="mt-4 rounded-lg border border-slate-200 p-3 text-sm">
      <summary className="cursor-pointer font-medium">Publicar a mano (plan B)</summary>
      <p className="mt-2 text-slate-600">
        Si el formulario automático no sirve, copia esto y publícalo tú en Facebook.
      </p>
      <dl className="mt-2 space-y-2">
        <div>
          <dt className="text-slate-500">Título</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {content?.title ?? "—"}
            {content?.title != null && (
              <CopyButton text={content.title} label="Copiar el título para Marketplace">
                Copiar título
              </CopyButton>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Descripción</dt>
          <dd>
            {content === undefined ? (
              "—"
            ) : (
              <CopyButton text={content.body} label="Copiar la descripción para Marketplace">
                Copiar descripción
              </CopyButton>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Precio</dt>
          <dd>{planBPrice(publications, listingPrice)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Fotos</dt>
          <dd className="flex flex-wrap gap-2">
            {photos.length === 0
              ? "—"
              : photos.map((photo, index) => {
                  // Solo `https` (la URL firmada de R2): otra cosa no va a un `href`.
                  const href = safeExternalUrl(photo.url);
                  return href === null ? (
                    <span key={photo.id}>Foto {index + 1}</span>
                  ) : (
                    <a
                      key={photo.id}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-700 underline"
                    >
                      Abrir foto {index + 1}
                    </a>
                  );
                })}
          </dd>
        </div>
      </dl>
    </details>
  );
}

/**
 * La pestaña Marketplace (spec F5 §4.12, F5-T13): lo que le falta al aviso, el texto con su
 * aprobación, las fotos 4:3 (las mismas de Portal), las publicaciones (formulario listo, pegar el
 * enlace, "No lo publiqué", publicada con su enlace y Marcar como retirada) y el plan B.
 */
export function MarketplacePanel({
  content,
  photos,
  edit,
  readiness,
}: {
  content: ContentView | undefined;
  photos: ContentMedia[];
  edit: EditContext;
  readiness: ReadinessView;
}) {
  const publications = edit.publications.filter((p) => p.platform === MARKETPLACE);
  return (
    <div>
      <MarketplaceReadiness readiness={readiness} />
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
              alt={`Foto ${index + 1} para Facebook Marketplace`}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-md bg-slate-100 object-cover"
            />
          </li>
        ))}
      </ul>
      <PublicationsPanel
        platform={MARKETPLACE}
        listingId={edit.listingId}
        listingStatus={edit.listingStatus}
        content={content}
        publications={publications}
        publishMode={edit.publishMode}
        runActive={edit.runActive}
        readiness={readiness}
      />
      <PlanB
        content={content}
        photos={photos}
        publications={publications}
        listingPrice={edit.listingPrice}
      />
    </div>
  );
}
