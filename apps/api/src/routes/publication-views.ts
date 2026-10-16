import {
  hasStartedLive,
  type MarketplaceReadiness,
  manualEditPayloadSchema,
  marketplaceManualState,
  type PortalReadiness,
  type Publication,
  type PublicationActor,
  type PublicationEvent,
  portalExpiry,
  publicationErrorAdvice,
  publishAttemptPayloadSchema,
  type SkippedPublication,
  scheduleChangedPayloadSchema,
  scheduleState,
} from "@agentsales/core";
import type { Context } from "hono";
import {
  CLI_CLIENT,
  CLIENT_HEADER,
  type MarketplaceManualView,
  type PublicationEventView,
  type PublicationView,
  type ReadinessView,
  type SkippedPublicationView,
} from "../contracts/index.js";

/**
 * La vista HTTP de una publicación: sin `progress` (interno del publisher) ni `externalId`, y sin
 * URLs de lo que se envía a la plataforma (spec F3-T15). En Marketplace suma `manual`, derivado del
 * progreso del intento actual (spec F5 §4.10). Desde F6-T10 suma lo derivado a la hora de pedir:
 * si una programada está atrasada, el consejo del error y el vencimiento de Portal.
 */
export const publicationView = (publication: Publication): PublicationView =>
  publicationViewAt(publication, new Date());

/** `publicationView` a una hora dada (no se pasa a `.map`: el índice se tomaría por la hora). */
const publicationViewAt = (publication: Publication, now: Date): PublicationView => ({
  id: publication.id,
  listingId: publication.listingId,
  platformAccountId: publication.platformAccountId,
  platform: publication.platform,
  format: publication.format,
  contentId: publication.contentId,
  mediaIds: publication.mediaIds,
  status: publication.status,
  dryRun: publication.dryRun,
  startedLive: hasStartedLive(publication),
  attempts: publication.attempts,
  lastError: publication.lastError,
  externalUrl: publication.externalUrl,
  scheduledAt: publication.scheduledAt,
  publishedAt: publication.publishedAt,
  remoteState: publication.remoteState,
  manual: manualView(publication),
  relistedFrom: publication.relistedFrom,
  schedule: scheduleState(publication, now),
  errorAdvice:
    publication.lastError === null ? null : publicationErrorAdvice(publication.lastError.code),
  expiry:
    publication.platform === "portal_inmobiliario"
      ? portalExpiry(publication.remoteState, now)
      : null,
  createdAt: publication.createdAt,
  updatedAt: publication.updatedAt,
});

/** `manual` campo por campo: un campo nuevo de core no sale por la API sin pasar por aquí. */
function manualView(publication: Publication): MarketplaceManualView | null {
  const manual = marketplaceManualState(publication);
  if (manual === null) return null;
  return {
    formReadyAt: manual.formReadyAt,
    simulated: manual.simulated,
    windowOpen: manual.windowOpen,
    windowClosedAt: manual.windowClosedAt,
    photos: manual.photos,
    priceClp: manual.priceClp,
    ufValue: manual.ufValue,
    ufDate: manual.ufDate,
  };
}

/** Lo que le falta al aviso para un canal, siempre con su lista (vacía si está listo). */
export const readinessView = (readiness: PortalReadiness | MarketplaceReadiness): ReadinessView =>
  readiness.ready
    ? { ready: true, issues: [] }
    : {
        ready: false,
        issues: readiness.issues.map(({ code, field, message }) => ({ code, field, message })),
      };

export const skippedView = ({
  platformAccountId,
  format,
  publicationId,
}: SkippedPublication): SkippedPublicationView => ({ platformAccountId, format, publicationId });

/** Las claves que core escribe en el detalle de un cambio de estado (abrir, iniciar, cerrar). */
const STATUS_PAYLOAD_KEYS = [
  "contentId",
  "mediaCount",
  "reason",
  "mode",
  "code",
  "attempt",
  "removedByHand",
  // Pausar, reactivar, cerrar y el sync (F4-T17): la operación y el estado en la plataforma.
  "operation",
  "sync",
  "remoteStatus",
  // Confirmar una de Marketplace (F5-T05): si la vio la ventana o la pegó el operador.
  "confirmedBy",
  // Calendario y la propiedad (F6): la hora programada, la que tenía al desprogramar, si el disparo
  // no pudo empezarla, si lo hizo la propiedad y con qué acción.
  "scheduledAt",
  "unscheduled",
  "due",
  "byListing",
  "action",
] as const;

/**
 * El detalle de un evento, filtrado al leer: no basta con que quien lo escribe no ponga secretos.
 * Un `publish_attempt` pasa por `publishAttemptPayloadSchema` (zod descarta lo que no conoce, como
 * una URL); un cambio de estado, solo sus claves conocidas; `schedule_changed` y `manual_edit`
 * (F6) por sus esquemas (de `manual_edit`, sin lo leído de la plataforma); `sync`, nada (su estado
 * queda en la publicación).
 */
function eventPayload(event: PublicationEvent): Record<string, unknown> {
  if (event.type === "publish_attempt") {
    const parsed = publishAttemptPayloadSchema.safeParse(event.payload);
    return parsed.success ? parsed.data : {};
  }
  if (event.type === "schedule_changed") {
    const parsed = scheduleChangedPayloadSchema.safeParse(event.payload);
    return parsed.success ? parsed.data : {};
  }
  if (event.type === "manual_edit") {
    const parsed = manualEditPayloadSchema.safeParse(event.payload);
    return parsed.success ? { mode: parsed.data.mode, fields: parsed.data.fields } : {};
  }
  if (event.type !== "status_changed") return {};
  return Object.fromEntries(
    STATUS_PAYLOAD_KEYS.filter((key) => key in event.payload).map((key) => [
      key,
      event.payload[key],
    ]),
  );
}

export const eventView = (event: PublicationEvent): PublicationEventView => ({
  id: event.id,
  type: event.type,
  fromStatus: event.fromStatus,
  toStatus: event.toStatus,
  actor: event.actor,
  payload: eventPayload(event),
  createdAt: event.createdAt,
});

/**
 * Quién pide el cambio, para la bitácora: la CLI se identifica con `X-AgentSales-Client: cli`. Es
 * informativo (cualquier proceso local puede mandarla), no autenticación: nunca da permisos.
 */
export const actorOf = (c: Context): PublicationActor =>
  c.req.header(CLIENT_HEADER)?.trim().toLowerCase() === CLI_CLIENT ? "cli" : "operator";
