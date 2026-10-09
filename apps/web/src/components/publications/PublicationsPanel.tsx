import type {
  ContentView,
  ListingPublicationView,
  PortalReadinessView,
} from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  type ListingStatus,
  PLATFORM_TEXT,
  type Platform,
  type PublishMode,
  publicationFormatText,
} from "@agentsales/core";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client.js";
import { useFreshPublishMode } from "../../queries/health.js";
import { usePublishListing } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { PublicationItem } from "./PublicationItem.js";
import {
  needsLiveConfirm,
  portalPublishBlockedReason,
  publishBlockedReason,
  publishButtonText,
  retireVerb,
  retryBlockedReason,
} from "./publications.js";

const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
const DANGER =
  "rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

const shown = new Set<string>([...ACTIVE_PUBLICATION_STATUSES, "failed"]);

/** Cómo se conecta la cuenta de cada canal, en Cuentas (`ACCOUNT_NOT_CONNECTED`). */
const ACCOUNT_TEXT: Partial<Record<Platform, string>> = {
  instagram: "la cuenta de Instagram",
  portal_inmobiliario: "la cuenta de Mercado Libre",
};

/**
 * Las publicaciones de un canal del aviso (spec F3 §4.9; Portal desde F4-T22): Publicar el canal
 * (en vivo, con confirmación) y cada publicación con su estado y acciones. Las descartadas y
 * retiradas van aparte. En Portal, Publicar se bloquea si al aviso le falta algo
 * (`portalReadiness`) o si la revisión del texto aprobado tiene errores.
 */
export function PublicationsPanel({
  platform,
  listingId,
  listingStatus,
  content,
  publications,
  publishMode,
  runActive,
  portalReadiness = null,
}: {
  platform: Platform;
  listingId: string;
  listingStatus: ListingStatus;
  content: ContentView | undefined;
  publications: readonly ListingPublicationView[];
  publishMode: PublishMode | undefined;
  runActive: boolean;
  portalReadiness?: PortalReadinessView | null;
}) {
  const publish = usePublishListing(listingId);
  const freshMode = useFreshPublishMode();
  const [confirming, setConfirming] = useState(false);
  const [requestedAt, setRequestedAt] = useState<Date | null>(null);
  const [backToReady, setBackToReady] = useState(false);
  const publishButton = useRef<HTMLButtonElement>(null);
  const current = publications.filter((publication) => shown.has(publication.status));
  const past = publications.filter((publication) => !shown.has(publication.status));
  const ofContent = publications.filter((publication) => publication.contentId === content?.id);
  // Hay algo que publicar si el texto está aprobado y no todas sus publicaciones salieron o están
  // saliendo (sin ninguna, nacen al publicar: la cuenta se conectó después de aprobar).
  const publishable =
    content?.status === "approved" &&
    (ofContent.length === 0 ||
      ofContent.some((p) => p.status === "approved" || p.status === "failed"));
  // Una fallida que empezó en vivo bloquea el canal entero en simulación (`PUBLISH_MODE_LOCKED`).
  const lockedLive = ofContent
    .filter((p) => p.status === "failed")
    .map((p) => retryBlockedReason(p, publishMode))
    .find((reason) => reason !== null);
  const blocked =
    publishBlockedReason(listingStatus, runActive) ??
    (platform === "portal_inmobiliario"
      ? portalPublishBlockedReason(content, portalReadiness)
      : null) ??
    (publishMode === undefined
      ? "Todavía no se sabe si la API está en simulación o en vivo."
      : (lockedLive ?? null));
  const channel = PLATFORM_TEXT[platform];

  const start = () => {
    setConfirming(false);
    setBackToReady(false);
    publish.mutate(platform, { onSuccess: () => setRequestedAt(new Date()) });
  };
  // El modo lo pone la API al publicar (D11): con la API en vivo se confirma, y en simulación se
  // vuelve a preguntar justo antes, por si cambió desde que se abrió la página.
  const request = async () => {
    publish.reset();
    if (needsLiveConfirm(publishMode)) return setConfirming(true);
    const mode = await freshMode().catch(() => undefined);
    if (mode !== "dry-run") return setConfirming(true);
    start();
  };
  const cancel = () => {
    setConfirming(false);
    requestAnimationFrame(() => publishButton.current?.focus());
  };

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-slate-700">Publicaciones</h3>
      {content?.status !== "approved" && publications.length === 0 && (
        <p className="mt-1 text-sm text-slate-500">Aprueba el texto para poder publicarlo.</p>
      )}
      {publishable && (
        <div className="mt-2">
          {confirming ? (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm">
              <p className="font-semibold text-red-800">
                La API está en vivo: se publicará de verdad en {channel}
                {platform === "portal_inmobiliario" ? " y usará un cupo de tu paquete" : ""}.
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={DANGER} onClick={start}>
                  Sí, publicar en vivo
                </button>
                {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
                <button type="button" autoFocus className="underline" onClick={cancel}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              ref={publishButton}
              type="button"
              className={PRIMARY}
              disabled={publish.isPending || blocked !== null}
              onClick={() => void request()}
            >
              {publishButtonText(platform, publishMode)}
            </button>
          )}
          {blocked !== null && <p className="mt-1 text-xs text-amber-800">{blocked}</p>}
        </div>
      )}
      {publish.data?.skipped.map((skipped) => (
        <p key={skipped.publicationId} className="mt-2 text-sm text-amber-800">
          El {publicationFormatText(platform, skipped.format)} tiene una publicación activa de un
          texto anterior: {retireVerb(platform)} o descártala para publicar el nuevo.
        </p>
      ))}
      {publish.data !== undefined && publish.data.stranded.length > 0 && (
        <p className="mt-2 text-sm text-amber-800">
          Hay publicaciones de una cuenta desconectada: descártalas o reconéctala en{" "}
          <Link to="/cuentas" className="underline">
            Cuentas
          </Link>
          .
        </p>
      )}
      {publish.error && (
        <>
          <ErrorAlert error={publish.error} />
          {publish.error instanceof ApiError && publish.error.code === "ACCOUNT_NOT_CONNECTED" && (
            <p className="mt-2 text-sm">
              Conecta {ACCOUNT_TEXT[platform] ?? "la cuenta"} del corredor en{" "}
              <Link to="/cuentas" className="underline">
                Cuentas
              </Link>
              .
            </p>
          )}
        </>
      )}
      {backToReady && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          Era la última publicada en vivo: la propiedad volvió a lista.
        </p>
      )}
      <div className="mt-3 flex flex-col gap-3">
        {current.map((publication) => (
          <PublicationItem
            key={publication.id}
            publication={publication}
            listingId={listingId}
            publishMode={publishMode}
            requestedAt={requestedAt}
            onListingBackToReady={() => setBackToReady(true)}
          />
        ))}
      </div>
      {past.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-slate-600">
            Descartadas y retiradas ({past.length})
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {past.map((publication) => (
              <PublicationItem
                key={publication.id}
                publication={publication}
                listingId={listingId}
                publishMode={publishMode}
                requestedAt={null}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
