import type { ContentView, ListingPublicationView, ReadinessView } from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  formatChileTime,
  type ListingPlatform,
  type ListingStatus,
  PLATFORM_TEXT,
  type Platform,
  type PublishMode,
  publicationFormatText,
  relistedIds,
} from "@agentsales/core";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client.js";
import { useAccounts } from "../../queries/accounts.js";
import { useFreshPublishMode } from "../../queries/health.js";
import { usePublishListing, useScheduleListings } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { PublicationItem } from "./PublicationItem.js";
import {
  accountMissingReason,
  hasSomethingToPublish,
  needsLiveConfirm,
  publishBlockedReason,
  publishButtonText,
  readinessPublishBlockedReason,
  retireVerb,
  retryBlockedReason,
} from "./publications.js";
import { ScheduleForm } from "./ScheduleForm.js";

const shown = new Set<string>([...ACTIVE_PUBLICATION_STATUSES, "failed"]);

/** Cómo se conecta la cuenta de cada canal, en Cuentas (`ACCOUNT_NOT_CONNECTED`). */
const ACCOUNT_TEXT: Partial<Record<Platform, string>> = {
  instagram: "tu cuenta de Instagram",
  portal_inmobiliario: "tu cuenta de Mercado Libre",
  fb_marketplace: "tu cuenta de Facebook",
};

/** La confirmación de publicar en vivo según el canal (Marketplace: quien publica es el operador, D3). */
const liveConfirmText = (platform: Platform, channel: string) =>
  platform === "fb_marketplace"
    ? "El sistema está en vivo: se abrirá Chromium con el formulario de Facebook Marketplace lleno de verdad; tú haces Siguiente y Publicar."
    : `El sistema está en vivo: se publicará de verdad en ${channel}${platform === "portal_inmobiliario" ? " y usará un cupo de tu paquete" : ""}.`;

/**
 * Las publicaciones de un canal del aviso (spec F3 §4.9; Portal desde F4-T22): Publicar el canal
 * (en vivo, con confirmación) y cada publicación con su estado y acciones. Las descartadas y
 * retiradas van aparte. En Portal y Marketplace, Publicar se bloquea si al aviso le falta algo
 * (`readiness`) o si la revisión del texto aprobado tiene errores.
 */
export function PublicationsPanel({
  platform,
  listingId,
  listingStatus,
  content,
  publications,
  publishMode,
  runActive,
  readiness = null,
  brokerId,
}: {
  platform: ListingPlatform;
  listingId: string;
  listingStatus: ListingStatus;
  content: ContentView | undefined;
  publications: readonly ListingPublicationView[];
  publishMode: PublishMode | undefined;
  runActive: boolean;
  readiness?: ReadinessView | null;
  /** El corredor del aviso: sin una cuenta suya conectada en este canal, no se publica (F9.5-T20). */
  brokerId?: string | undefined;
}) {
  const publish = usePublishListing(listingId);
  const schedule = useScheduleListings();
  const [scheduling, setScheduling] = useState(false);
  const freshMode = useFreshPublishMode();
  // Todas las cuentas que la sesión ve: un administrador con otro corredor elegido mira igual las
  // del corredor del aviso (F9.5-T12).
  const accounts = useAccounts();
  const missingAccount = accountMissingReason(platform, accounts.data?.accounts, brokerId);
  const [confirming, setConfirming] = useState(false);
  const [requestedAt, setRequestedAt] = useState<Date | null>(null);
  const [backToReady, setBackToReady] = useState(false);
  const publishButton = useRef<HTMLButtonElement>(null);
  const current = publications.filter((publication) => shown.has(publication.status));
  const relisted = relistedIds(publications);
  const past = publications.filter((publication) => !shown.has(publication.status));
  const ofContent = publications.filter((publication) => publication.contentId === content?.id);
  // Hay algo que publicar si el texto está aprobado y no todas sus publicaciones salieron o están
  // saliendo (sin ninguna, nacen al publicar: la cuenta se conectó después de aprobar).
  const publishable = content !== undefined && hasSomethingToPublish([content], publications);
  // Una fallida que empezó en vivo bloquea el canal entero en simulación (`PUBLISH_MODE_LOCKED`).
  const lockedLive = ofContent
    .filter((p) => p.status === "failed")
    .map((p) => retryBlockedReason(p, publishMode))
    .find((reason) => reason !== null);
  const blocked =
    missingAccount ??
    publishBlockedReason(listingStatus, runActive) ??
    (platform === "portal_inmobiliario"
      ? readinessPublishBlockedReason(content, readiness)
      : platform === "fb_marketplace"
        ? readinessPublishBlockedReason(content, readiness, "Marketplace")
        : null) ??
    (publishMode === undefined
      ? "Todavía no se sabe si el sistema está en simulación o en vivo."
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
      <h3 className="text-sm font-semibold text-fg">Publicaciones</h3>
      {content?.status !== "approved" && publications.length === 0 && (
        <p className="mt-1 text-sm text-fg-subtle">Aprueba el texto para poder publicarlo.</p>
      )}
      {publishable && (
        <div className="mt-2">
          {confirming ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm"
            >
              <p className="font-semibold text-danger-800">{liveConfirmText(platform, channel)}</p>
              <div className="mt-2 flex gap-2">
                <Button variant="danger" size="sm" onClick={start}>
                  Sí, publicar en vivo
                </Button>
                <Button variant="link" autoFocus onClick={cancel}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                ref={publishButton}
                disabled={publish.isPending || blocked !== null}
                onClick={() => void request()}
              >
                {publishButtonText(platform, publishMode)}
              </Button>
              {!scheduling && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={schedule.isPending || blocked !== null}
                  onClick={() => {
                    schedule.reset();
                    setScheduling(true);
                  }}
                >
                  Programar {channel}
                </Button>
              )}
            </div>
          )}
          {scheduling && (
            <ScheduleForm
              publishMode={publishMode}
              pending={schedule.isPending}
              submitLabel={`Programar ${channel}`}
              onSubmit={(at) =>
                schedule.mutate(
                  { listingIds: [listingId], platforms: [platform], at },
                  { onSuccess: () => setScheduling(false) },
                )
              }
              onCancel={() => setScheduling(false)}
            />
          )}
          {schedule.data?.results.map((row) => (
            <p
              key={`${row.listingId}-${row.platform ?? "todo"}`}
              role="status"
              className={`mt-2 text-sm ${row.outcome === "scheduled" ? "text-fg-muted" : "text-warning-800"}`}
            >
              {row.outcome === "scheduled"
                ? `Programado para el ${row.at === undefined ? "" : formatChileTime(row.at)} (hora de Chile).`
                : `No se programó: ${row.message ?? row.code ?? ""}`}
            </p>
          ))}
          {schedule.data?.notes.map((note) => (
            <p key={note} className="mt-1 text-sm text-warning-800">
              {note}
            </p>
          ))}
          {schedule.error && <ErrorAlert error={schedule.error} />}
          {blocked !== null && (
            <p className="mt-1 text-xs text-warning-800">
              {blocked}
              {missingAccount !== null && (
                <>
                  {" "}
                  <Link
                    to="/cuentas"
                    className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
                  >
                    Ir a Cuentas
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      )}
      {publish.data?.skipped.map((skipped) => (
        <p key={skipped.publicationId} className="mt-2 text-sm text-warning-800">
          El {publicationFormatText(platform, skipped.format, null)} tiene una publicación activa de
          un texto anterior: {retireVerb(platform)} o descártala para publicar el nuevo.
        </p>
      ))}
      {publish.data !== undefined && publish.data.stranded.length > 0 && (
        <p className="mt-2 text-sm text-warning-800">
          Hay publicaciones de una cuenta desconectada: descártalas o reconéctala en{" "}
          <Link
            to="/cuentas"
            className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
          >
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
              Conecta {ACCOUNT_TEXT[platform] ?? "tu cuenta"} en{" "}
              <Link
                to="/cuentas"
                className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
              >
                Cuentas
              </Link>
              .
            </p>
          )}
        </>
      )}
      {backToReady && (
        <p role="status" className="mt-2 text-sm text-fg-muted">
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
            listingStatus={listingStatus}
            relisted={relisted}
            scheduleBlocked={publishBlockedReason(listingStatus, runActive)}
          />
        ))}
      </div>
      {past.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-fg-muted">
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
                listingStatus={listingStatus}
                relisted={relisted}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
