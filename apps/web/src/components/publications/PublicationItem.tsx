import type { ListingPublicationView } from "@agentsales/api/contracts";
import {
  CHILE_TIME_ZONE,
  formatChileTime,
  type ListingStatus,
  marketplacePriceText,
  PLATFORM_TEXT,
  type PublishMode,
  publicationFormatText,
  publicationModeText,
  remoteStatusText,
} from "@agentsales/core";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client.js";
import { useFreshPublishMode } from "../../queries/health.js";
import {
  isPublishing,
  type PublicationAction,
  SYNC_REFRESH_MS,
  usePublicationAction,
  usePublicationPoll,
  usePublicationsRefresh,
} from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { PollStoppedAlert } from "../PollStoppedAlert.js";
import { PublicationStatusBadge } from "../StatusBadge.js";
import { MarketplaceConfirm } from "./MarketplaceConfirm.js";
import { PublicationEvents } from "./PublicationEvents.js";
import {
  needsLiveConfirm,
  publicationActions,
  retryBlockedReason,
  safeExternalUrl,
} from "./publications.js";
import { ScheduleForm } from "./ScheduleForm.js";

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const DANGER = "rounded-md bg-red-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-50";

type Confirming =
  | "cancel"
  | "retire"
  | "live-retry"
  | "close"
  | "schedule"
  | "update"
  | "relist"
  | null;

/** Lo que la API pide confirmar al actualizar o republicar en vivo (con su motivo). */
const CONFIRM_CODES: Readonly<Record<string, "update" | "relist">> = {
  UPDATE_NOT_CONFIRMED: "update",
  RELIST_NOT_CONFIRMED: "relist",
};

/**
 * Lo programado (spec F6 §4.3 y §4.4): la hora en Chile, y si está atrasada (más de 12 h: no sale
 * sola) o si es un recordatorio de Marketplace al que le llegó la hora ("te toca").
 */
function ScheduleState({ publication }: { publication: ListingPublicationView }) {
  if (publication.status !== "scheduled" || publication.scheduledAt === null) return null;
  const at = formatChileTime(publication.scheduledAt);
  if (publication.schedule === "overdue") {
    return (
      <p className="mt-1 text-sm text-amber-800">
        <span className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold">
          Atrasada
        </span>
        Era para el {at} y no salió (el worker estuvo apagado más de 12 h): publícala ahora,
        reprográmala o descártala.
      </p>
    );
  }
  if (publication.platform === "fb_marketplace" && publication.schedule === "due") {
    return (
      <p className="mt-1 text-sm font-semibold text-sky-800">
        Te toca: era para el {at}. Aprieta Publicar ahora y sigue en la ventana de Facebook.
      </p>
    );
  }
  return (
    <p className="mt-1 text-sm text-slate-700">
      Programada para el {at} (hora de Chile)
      {publication.platform === "fb_marketplace" ? ": a esa hora te toca publicarla a ti" : ""}.
    </p>
  );
}

/** Portal: "vence en N días" (7 o menos) o "venció" (spec F6 §4.7). */
function Expiry({ publication }: { publication: ListingPublicationView }) {
  const expiry = publication.expiry;
  if (expiry === null) return null;
  if (expiry.expired) {
    return (
      <p className="mt-1 text-sm font-semibold text-amber-800">
        {publication.status === "unpublished"
          ? "El aviso venció: republícalo."
          : "El aviso venció en Mercado Libre: usa Actualizar para leer su estado."}
      </p>
    );
  }
  if (!expiry.soon) return null;
  return (
    <p className="mt-1 text-sm text-amber-800">
      Vence en {expiry.daysLeft} {expiry.daysLeft === 1 ? "día" : "días"}.
    </p>
  );
}

/**
 * Si un pedido sobre un aviso de Portal se cortó (la API no contestó a tiempo o se cayó a mitad),
 * el cambio pudo aplicarse en Mercado Libre: no se invita a repetir, como en la CLI
 * (`OPERATION_UNCONFIRMED`, spec F4-T20). Pedir la lectura se puede repetir: no duplica nada.
 */
function cutHint(error: Error, kind: PublicationAction["kind"] | undefined): string | undefined {
  if (!(error instanceof ApiError) || (error.code !== "TIMEOUT" && error.code !== "UNREACHABLE")) {
    return undefined;
  }
  if (kind === "pause" || kind === "resume" || kind === "close") {
    return "Pudo haberse aplicado en Mercado Libre: no lo repitas todavía. Usa Actualizar en un momento o recarga la página.";
  }
  if (kind === "sync")
    return "No se supo si la lectura quedó pedida: puedes repetirla (no duplica nada).";
  return undefined;
}

/** Qué no se hizo en una simulación, según el canal. */
const SIMULATION_TEXT: Readonly<Record<ListingPublicationView["platform"], string>> = {
  instagram: "Simulación: no se envió nada a Instagram.",
  portal_inmobiliario: "Simulación: no se creó ni cambió nada en Mercado Libre.",
  fb_marketplace: "Simulación: no se abrió ni publicó nada en Facebook.",
  // F9: las redes de los posts (sin publisher todavía).
  x: "Simulación: no se envió nada a X.",
  linkedin: "Simulación: no se envió nada a LinkedIn.",
  discord: "Simulación: no se envió nada a Discord.",
  tiktok: "Simulación: no se envió nada a TikTok.",
};

/** La confirmación de reintentar en vivo según el canal (Marketplace: quien publica es el operador). */
const liveRetryText = (publication: ListingPublicationView, format: string, channel: string) =>
  publication.platform === "fb_marketplace"
    ? "La API está en vivo: se abrirá Chromium con un formulario nuevo de Facebook Marketplace; tú haces Siguiente y Publicar."
    : `La API está en vivo: el ${format} se publicará de verdad en ${channel}${publication.platform === "portal_inmobiliario" ? " y usará un cupo de tu paquete" : ""}.`;

/** Una fecha en hora de Chile (el vencimiento en la plataforma). */
const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString("es-CL", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: CHILE_TIME_ZONE,
  });

/**
 * El estado en Mercado Libre (`remoteState`, spec F4 §4.12): `remoteStatusText`, el vencimiento
 * (`stopTime`) y, si la pausó Mercado Libre, el motivo (con texto propio, nunca el de la plataforma).
 */
function RemoteState({ publication }: { publication: ListingPublicationView }) {
  const remote = publication.remoteState;
  if (remote === null) return null;
  return (
    <div className="mt-1 text-sm text-slate-700">
      <p>
        En Mercado Libre: <span className="font-medium">{remoteStatusText(remote)}</span>
        {remote.stopTime !== null && <> · vence el {dateText(remote.stopTime)}</>}
      </p>
      {remote.reason !== undefined && <p className="text-amber-800">{remote.reason.message}</p>}
    </div>
  );
}

/** Las miniaturas de una pendiente (imágenes, o el reel en video, que es el MP4 completo). */
function Thumbnails({ publication }: { publication: ListingPublicationView }) {
  if (publication.media.length === 0) return null;
  const format = publicationFormatText(publication.platform, publication.format);
  return (
    <ul aria-label={`Medios del ${format}`} className="mt-2 flex gap-1 overflow-x-auto">
      {publication.media.map((media, index) => (
        <li key={media.id} className="flex-none">
          {media.mime.startsWith("video/") ? (
            <video
              src={media.url}
              preload="metadata"
              muted
              aria-label={`Video del ${format}`}
              className="h-16 w-9 rounded bg-black object-cover"
            />
          ) : (
            <img
              src={media.url}
              alt={`Imagen ${index + 1} del ${format}`}
              loading="lazy"
              className="h-16 w-14 rounded bg-slate-100 object-cover"
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Una publicación (spec F3 §4.9): estado, modo, enlace o error legible, y Reintentar (en vivo, con
 * confirmación), Volver a encolar, Descartar y Marcar como retirada (con confirmación; en vivo, que
 * ya se borró a mano). Mientras está en `publishing` se sondea; el tope cuenta desde el clic o el
 * último cambio. Un aviso de Portal (spec F4 §4.12, desde F4-T22) muestra su estado en Mercado
 * Libre y, en vez de retirar, Pausar, Reactivar, Cerrar (con confirmación; en vivo, irreversible) y
 * Actualizar (solo en vivo). Una de Marketplace (spec F5 §4.12, F5-T13) que espera el clic final
 * muestra `MarketplaceConfirm`; publicada, su enlace, el precio que se escribió y Marcar como
 * retirada (en vivo, después de borrarla a mano en Facebook).
 */
export function PublicationItem({
  publication: listed,
  listingId,
  publishMode,
  requestedAt: panelRequestedAt,
  onListingBackToReady,
  listingStatus,
  relisted = new Set(),
  scheduleBlocked = null,
}: {
  publication: ListingPublicationView;
  listingId: string;
  publishMode: PublishMode | undefined;
  requestedAt: Date | null;
  /** Para republicar (`canRelist`): el estado de la propiedad (sin él, no se ofrece). */
  listingStatus?: ListingStatus;
  /** Las publicaciones que ya tienen una republicación viva. */
  relisted?: ReadonlySet<string>;
  /** Por qué no se puede programar ahora (la propiedad no está lista, una corrida en curso). */
  scheduleBlocked?: string | null;
  /** Retirar o cerrar la última en vivo devolvió el aviso a `ready`. */
  onListingBackToReady?: () => void;
}) {
  const [ownRequestedAt, setOwnRequestedAt] = useState<Date | null>(null);
  const requestedAt =
    ownRequestedAt !== null && (panelRequestedAt === null || ownRequestedAt > panelRequestedAt)
      ? ownRequestedAt
      : panelRequestedAt;
  const { query: poll, stopped } = usePublicationPoll(listingId, listed, requestedAt);
  const action = usePublicationAction(listingId);
  const refresh = usePublicationsRefresh(listingId);
  const freshMode = useFreshPublishMode();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncRequestedAt, setSyncRequestedAt] = useState<number | null>(null);
  const [removedByHand, setRemovedByHand] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  // El botón que abrió una confirmación se desmonta mientras se confirma: se recuerda su nombre
  // para devolverle el foco al volver a aparecer.
  const openerLabel = useRef<string | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const [retryReason, setRetryReason] = useState<"retry" | "publish-now">("retry");
  // Lo sondeado (de esta misma versión del listado) es lo más nuevo mientras se publica.
  const publication = poll.data === undefined ? listed : { ...listed, ...poll.data };
  const format = publicationFormatText(publication.platform, publication.format);
  const channel = PLATFORM_TEXT[publication.platform];
  const portal = publication.platform === "portal_inmobiliario";
  const actions = publicationActions(
    publication,
    listingStatus === undefined ? undefined : { listingStatus, relisted },
  );
  const retryBlocked = retryBlockedReason(publication, publishMode);
  const modeUnknown = publishMode === undefined;
  const live = !publication.dryRun;
  const link = safeExternalUrl(publication.externalUrl);

  // Pedida la lectura, el worker la hace en unos segundos: el listado se vuelve a pedir una vez.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` es nuevo en cada render; basta con el pedido.
  useEffect(() => {
    if (syncRequestedAt === null) return;
    const timer = setTimeout(refresh, SYNC_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [syncRequestedAt]);

  const open = (next: Exclude<Confirming, null>, button: HTMLButtonElement) => {
    openerLabel.current = button.getAttribute("aria-label");
    action.reset();
    setNotice(null);
    setConfirming(next);
  };
  const close = () => {
    setConfirming(null);
    setRemovedByHand(false);
    // El botón que abrió la confirmación vuelve a aparecer: el foco vuelve a él.
    requestAnimationFrame(() => focusButton(card.current, openerLabel.current));
  };
  const run = (next: Parameters<typeof action.mutate>[0]) => {
    setNotice(null);
    action.mutate(next, {
      onSuccess: (result) => {
        if (next.kind === "publish") setOwnRequestedAt(new Date());
        // Lo muestra el panel: la publicación pasa a "Descartadas y retiradas" y esta tarjeta se
        // vuelve a montar ahí, así que un aviso propio se perdería.
        if (result.listingBackToReady) onListingBackToReady?.();
        if (next.kind === "update") {
          setNotice(
            publication.dryRun
              ? "Aviso actualizado en simulación: no se cambió nada en Mercado Libre."
              : "Aviso actualizado en Mercado Libre: en unos segundos se lee su estado.",
          );
        }
        if (next.kind === "relist") {
          setNotice("Republicación pedida: aparece como una publicación nueva de este canal.");
        }
        if (next.kind === "sync") {
          setNotice(
            result.queued
              ? "Se pidió leer el estado en Mercado Libre: se actualiza en unos segundos (con el worker corriendo)."
              : "Ya hay una lectura programada: el estado se actualiza en un momento.",
          );
          setSyncRequestedAt(Date.now());
        }
      },
      onError: (error) => {
        // Actualizar o republicar en vivo: la API pide confirmar, con su motivo (spec F6 §4.7).
        const ask =
          error instanceof ApiError && error.code !== undefined
            ? CONFIRM_CODES[error.code]
            : undefined;
        if (ask !== undefined && (next.kind === "update" || next.kind === "relist")) {
          action.reset();
          setConfirmMessage(error.message);
          setConfirming(ask);
        }
      },
      onSettled: (_result, error) => {
        const asked =
          error instanceof ApiError &&
          error.code !== undefined &&
          CONFIRM_CODES[error.code] !== undefined;
        if (!asked) setConfirming(null);
        setRemovedByHand(false);
      },
    });
  };
  // Reintentar fija el modo con que va (el de la API ahora, D11): se confirma si va en vivo o si el
  // modo cambió desde que se abrió la página.
  const retry = async (button: HTMLButtonElement, reason: "retry" | "publish-now" = "retry") => {
    setRetryReason(reason);
    if (needsLiveConfirm(publishMode)) return open("live-retry", button);
    const mode = await freshMode().catch(() => undefined);
    if (mode !== "dry-run") return open("live-retry", button);
    run({ kind: "publish", id: publication.id });
  };

  return (
    <article
      ref={card}
      aria-label={`Publicación ${format}`}
      className="rounded-lg border border-slate-200 bg-white p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold capitalize">{format}</h4>
        <PublicationStatusBadge status={publication.status} />
        <span className="text-xs text-slate-500">{publicationModeText(publication.dryRun)}</span>
      </div>
      {/* Siempre montada: los lectores de pantalla anuncian los cambios de una región que ya estaba. */}
      <p aria-live="polite" className="mt-1 text-sm text-slate-700">
        {isPublishing(publication.status) ? "Publicando…" : ""}
      </p>
      {link !== null && (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="block text-sm break-all text-sky-700 underline"
        >
          Ver en {channel}
        </a>
      )}
      <RemoteState publication={publication} />
      <ScheduleState publication={publication} />
      <Expiry publication={publication} />
      {publication.status === "published" && publication.dryRun && (
        <p className="mt-1 text-xs text-slate-500">{SIMULATION_TEXT[publication.platform]}</p>
      )}
      {publication.status === "published" && publication.manual !== null && (
        <p className="mt-1 text-xs text-slate-600">
          Precio en el formulario: {marketplacePriceText(publication.manual)}
        </p>
      )}
      {actions.confirm && confirming === null && (
        <MarketplaceConfirm
          publication={publication}
          listingId={listingId}
          pending={action.isPending}
          run={run}
        />
      )}
      {publication.lastError !== null && publication.status === "failed" && (
        <>
          <p className="mt-1 text-sm text-red-700">{publication.lastError.message}</p>
          {publication.errorAdvice !== null && (
            <p className="mt-1 text-sm text-slate-700">Qué hacer: {publication.errorAdvice}</p>
          )}
        </>
      )}
      <Thumbnails publication={listed} />
      {poll.error && poll.data === undefined && (
        <ErrorAlert
          error={poll.error}
          onRetry={() => void poll.refetch()}
          retrying={poll.isFetching}
        />
      )}
      {stopped && (
        <PollStoppedAlert
          stopped={stopped}
          noun="La publicación"
          onRetry={() => void poll.refetch()}
          retrying={poll.isFetching}
        />
      )}

      {confirming === null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions.retry && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Reintentar el ${format}`}
              disabled={action.isPending || retryBlocked !== null || modeUnknown}
              onClick={(event) => void retry(event.currentTarget)}
            >
              Reintentar
            </button>
          )}
          {actions.publishNow && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Publicar ahora el ${format}`}
              disabled={action.isPending || modeUnknown}
              onClick={(event) => void retry(event.currentTarget, "publish-now")}
            >
              Publicar ahora
            </button>
          )}
          {(actions.schedule || actions.reschedule) && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`${actions.reschedule ? "Reprogramar" : "Programar"} el ${format}`}
              disabled={action.isPending || scheduleBlocked !== null}
              title={scheduleBlocked ?? undefined}
              onClick={(event) => open("schedule", event.currentTarget)}
            >
              {actions.reschedule ? "Reprogramar" : "Programar"}
            </button>
          )}
          {actions.unschedule && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Desprogramar el ${format}`}
              disabled={action.isPending}
              onClick={() => run({ kind: "unschedule", id: publication.id })}
            >
              Desprogramar
            </button>
          )}
          {actions.update && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Actualizar el aviso del ${format} en ${channel}`}
              disabled={action.isPending}
              onClick={(event) => {
                openerLabel.current = event.currentTarget.getAttribute("aria-label");
                run({ kind: "update", id: publication.id, confirmed: false });
              }}
            >
              {action.isPending && action.variables?.kind === "update"
                ? "Actualizando…"
                : "Actualizar aviso"}
            </button>
          )}
          {actions.relist && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Republicar el ${format}`}
              disabled={action.isPending}
              onClick={(event) => {
                openerLabel.current = event.currentTarget.getAttribute("aria-label");
                run({ kind: "relist", id: publication.id, confirmed: false });
              }}
            >
              Republicar
            </button>
          )}
          {isPublishing(publication.status) && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Volver a encolar el ${format}`}
              disabled={action.isPending}
              onClick={() => run({ kind: "publish", id: publication.id })}
            >
              Volver a encolar
            </button>
          )}
          {actions.cancel && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Descartar el ${format}`}
              onClick={(event) => open("cancel", event.currentTarget)}
            >
              Descartar
            </button>
          )}
          {actions.pause && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Pausar el ${format}`}
              disabled={action.isPending}
              onClick={() => run({ kind: "pause", id: publication.id })}
            >
              {action.isPending && action.variables?.kind === "pause" ? "Pausando…" : "Pausar"}
            </button>
          )}
          {actions.resume && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Reactivar el ${format}`}
              disabled={action.isPending}
              onClick={() => run({ kind: "resume", id: publication.id })}
            >
              {action.isPending && action.variables?.kind === "resume"
                ? "Reactivando…"
                : "Reactivar"}
            </button>
          )}
          {actions.close && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Cerrar el ${format}`}
              disabled={action.isPending}
              onClick={(event) => open("close", event.currentTarget)}
            >
              Cerrar
            </button>
          )}
          {actions.sync && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Actualizar el estado del ${format}`}
              disabled={action.isPending}
              onClick={() => run({ kind: "sync", id: publication.id })}
            >
              Actualizar
            </button>
          )}
          {actions.retire && (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Marcar como retirado el ${format}`}
              onClick={(event) => open("retire", event.currentTarget)}
            >
              Marcar como retirada
            </button>
          )}
          <button
            type="button"
            className="text-xs underline"
            aria-expanded={showEvents}
            aria-label={`Bitácora del ${format}`}
            onClick={() => setShowEvents(!showEvents)}
          >
            {showEvents ? "Ocultar bitácora" : "Ver bitácora"}
          </button>
        </div>
      )}
      {actions.retry && retryBlocked !== null && (
        <p className="mt-1 text-xs text-amber-800">{retryBlocked}</p>
      )}
      {actions.retry && modeUnknown && (
        <p className="mt-1 text-xs text-amber-800">
          Todavía no se sabe si la API está en simulación o en vivo.
        </p>
      )}
      {isPublishing(publication.status) && (
        <p className="mt-1 text-xs text-slate-500">
          Volver a encolar sirve si el worker estuvo apagado o la cola falló: no la publica dos
          veces.
        </p>
      )}

      {confirming === "live-retry" && (
        <div role="alert" className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm">
          <p className="font-semibold text-red-800">
            {retryReason === "publish-now"
              ? `Se publicará ahora, sin esperar la hora programada. ${liveRetryText(publication, format, channel)}`
              : liveRetryText(publication, format, channel)}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={action.isPending}
              onClick={() => run({ kind: "publish", id: publication.id })}
            >
              {retryReason === "publish-now"
                ? "Sí, publicar ahora en vivo"
                : "Sí, reintentar en vivo"}
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="text-xs underline" onClick={close}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {confirming === "schedule" && (
        <ScheduleForm
          publishMode={publishMode}
          initial={publication.scheduledAt}
          pending={action.isPending}
          submitLabel={actions.reschedule ? "Reprogramar" : "Programar"}
          onSubmit={(at) => run({ kind: "schedule", id: publication.id, at })}
          onCancel={close}
        />
      )}
      {(confirming === "update" || confirming === "relist") && (
        <div role="alert" className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm">
          <p className="font-semibold text-red-800">{confirmMessage}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={action.isPending}
              onClick={() => run({ kind: confirming, id: publication.id, confirmed: true })}
            >
              {confirming === "update" ? "Sí, actualizar en vivo" : "Sí, republicar en vivo"}
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="text-xs underline" onClick={close}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {confirming === "cancel" && (
        <fieldset className="mt-2 text-sm">
          <legend>
            ¿Descartar el {format}? El texto sigue aprobado: publicar de nuevo abre otro.
            {publication.startedLive &&
              ` Ojo: ya empezó en vivo, así que pudo haber salido en ${channel}; revísalo antes.`}
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={action.isPending}
              onClick={() => run({ kind: "cancel", id: publication.id })}
            >
              Sí, descartar
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="text-xs underline" onClick={close}>
              No
            </button>
          </div>
        </fieldset>
      )}
      {confirming === "retire" && (
        <fieldset className="mt-2 space-y-2 text-sm">
          <legend className="sr-only">Marcar como retirado el {format}</legend>
          {live ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={removedByHand}
                onChange={(event) => setRemovedByHand(event.target.checked)}
              />
              Ya la borré a mano en {channel} (AgentSales no puede borrarla)
            </label>
          ) : (
            <p>Es una simulación: no hay nada que borrar en {channel}.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={action.isPending || (live && !removedByHand)}
              onClick={() => run({ kind: "retire", id: publication.id, removedByHand: live })}
            >
              Sí, marcar como retirada
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="text-xs underline" onClick={close}>
              Cancelar
            </button>
          </div>
        </fieldset>
      )}
      {confirming === "close" && (
        <fieldset className="mt-2 space-y-2 text-sm">
          <legend>
            {live
              ? `¿Cerrar el ${format} en ${channel}? Es irreversible: volver a publicar crea un aviso nuevo y usa otro cupo.`
              : `¿Cerrar el ${format}? Es una simulación: no se cambia nada en Mercado Libre.`}
          </legend>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={action.isPending}
              onClick={() => run({ kind: "close", id: publication.id, confirmed: live })}
            >
              {action.isPending ? "Cerrando…" : "Sí, cerrar"}
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="text-xs underline" onClick={close}>
              Cancelar
            </button>
          </div>
        </fieldset>
      )}
      {notice !== null && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {notice}
        </p>
      )}
      {action.error && (
        <ErrorAlert
          error={action.error}
          {...(cutHint(action.error, action.variables?.kind) === undefined
            ? {}
            : { hint: cutHint(action.error, action.variables?.kind) })}
        />
      )}
      {action.error instanceof ApiError &&
        (action.error.code === "ML_AUTH_INVALID" ||
          action.error.code === "ACCOUNT_NOT_CONNECTED") && (
          <p className="mt-2 text-sm">
            Reconecta la cuenta de{" "}
            {portal
              ? "Mercado Libre"
              : publication.platform === "fb_marketplace"
                ? "Facebook"
                : "Instagram"}{" "}
            del corredor en{" "}
            <Link to="/cuentas" className="underline">
              Cuentas
            </Link>
            .
          </p>
        )}
      {action.error instanceof ApiError &&
        (action.error.code === "ML_ABORTED" || action.error.code === "ML_CONFLICT") &&
        actions.sync && (
          <p className="mt-2 text-sm">Usa Actualizar en un momento para ver cómo quedó.</p>
        )}
      {showEvents && <PublicationEvents publicationId={publication.id} />}
    </article>
  );
}

/** Devuelve el foco al botón con ese `aria-label` dentro de la tarjeta (ya vuelto a montar). */
function focusButton(container: HTMLElement | null, label: string | null) {
  if (container === null || label === null) return;
  for (const button of container.querySelectorAll("button")) {
    if (button.getAttribute("aria-label") === label) {
      button.focus();
      return;
    }
  }
}
