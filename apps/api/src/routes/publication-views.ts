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
import type { AppEnv } from "../auth.js";
import type {
  MarketplaceManualView,
  PublicationEventView,
  PublicationView,
  ReadinessView,
  SkippedPublicationView,
} from "../contracts/index.js";

/**
 * La vista HTTP de una publicación: sin `progress` (interno del publisher) ni `externalId`, y sin
 * URLs de lo que se envía a la plataforma (spec F3-T15). En Marketplace suma `manual`, derivado del
 * progreso del intento actual (spec F5 §4.10). Desde F6-T10 suma lo derivado a la hora de pedir:
 * si una programada está atrasada, el consejo del error y el vencimiento de Portal.
 */
export const publicationView = (publication: Publication): PublicationView =>
  publicationViewAt(publication, new Date());

/**
 * `publicationView` a una hora dada: la de la ruta (deuda de F6), así la vista y lo que la ruta
 * calcula con su reloj coinciden. No se pasa a `.map` (el índice se tomaría por la hora).
 */
export const publicationViewAt = (publication: Publication, now: Date): PublicationView => ({
  id: publication.id,
  // El sujeto en sus dos campos (F9-T06): exactamente uno tiene valor.
  listingId: publication.subject.kind === "listing" ? publication.subject.id : null,
  postId: publication.subject.kind === "post" ? publication.subject.id : null,
  platformAccountId: publication.platformAccountId,
  platform: publication.platform,
  format: publication.format,
  language: publication.language,
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
    byHand: manual.byHand,
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
  // F9-T19: retirada borrando por la API (LinkedIn en modo `api`).
  "removedByApi",
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
  // Resolver una con resultado dudoso (F9-T06): lo que dijo el operador.
  "outcome",
] as const;

/**
 * El detalle de un evento, filtrado al leer: no basta con que quien lo escribe no ponga secretos.
 * Un `publish_attempt` pasa por `publishAttemptPayloadSchema` (zod descarta lo que no conoce, como
 * una URL); un cambio de estado, solo sus claves conocidas; `schedule_changed` y `manual_edit`
 * (F6) por sus esquemas (de `manual_edit`, sin lo leído de la plataforma); `sync`, nada (su estado
 * queda en la publicación) salvo la marca de una pausa de la propiedad que un sync se adelantó a
 * aplicar (`byListing`, F8-T12).
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
  if (event.type === "sync") return event.payload.byListing === true ? { byListing: true } : {};
  if (event.type !== "status_changed") return {};
  return Object.fromEntries(
    STATUS_PAYLOAD_KEYS.filter((key) => key in event.payload).map((key) => [
      key,
      event.payload[key],
    ]),
  );
}

/**
 * Un evento de la bitácora con el nombre de quien lo hizo (`names`: usuario → nombre; spec F7
 * §4.3). Se usa como `events.map(eventViewWith(names))`.
 */
export const eventViewWith =
  (names: ReadonlyMap<string, string>) =>
  (event: PublicationEvent): PublicationEventView => ({
    id: event.id,
    type: event.type,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actor: event.actor,
    userName: event.userId === null ? null : (names.get(event.userId) ?? null),
    payload: eventPayload(event),
    createdAt: event.createdAt,
  });

/** Un evento sin nombres (lo del sistema, o donde no hace falta quién). */
export const eventView = (event: PublicationEvent): PublicationEventView =>
  eventViewWith(new Map())(event);

/**
 * Por dónde se pidió el cambio, para la bitácora (spec F7 §4.3): sale de la sesión (`cli` con el
 * `Bearer` de la CLI; `operator`, el panel). Quién fue lo anota `withEventUser`.
 */
export const actorOf = (c: Context): PublicationActor =>
  (c as Context<AppEnv>).get("auth")?.client === "cli" ? "cli" : "operator";
