import {
  hasStartedLive,
  type Publication,
  type PublicationActor,
  type PublicationEvent,
  publishAttemptPayloadSchema,
  type SkippedPublication,
} from "@agentsales/core";
import type { Context } from "hono";
import {
  CLI_CLIENT,
  CLIENT_HEADER,
  type PublicationEventView,
  type PublicationView,
  type SkippedPublicationView,
} from "../contracts/index.js";

/**
 * La vista HTTP de una publicación: sin `progress` (interno del publisher) ni `externalId`, y sin
 * URLs de lo que se envía a la plataforma (spec F3-T15).
 */
export const publicationView = (publication: Publication): PublicationView => ({
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
  createdAt: publication.createdAt,
  updatedAt: publication.updatedAt,
});

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
] as const;

/**
 * El detalle de un evento, filtrado al leer: no basta con que quien lo escribe no ponga secretos.
 * Un `publish_attempt` pasa por `publishAttemptPayloadSchema` (zod descarta lo que no conoce, como
 * una URL); un cambio de estado, solo sus claves conocidas; `sync` y `manual_edit` (F6), nada hasta
 * que tengan su esquema.
 */
function eventPayload(event: PublicationEvent): Record<string, unknown> {
  if (event.type === "publish_attempt") {
    const parsed = publishAttemptPayloadSchema.safeParse(event.payload);
    return parsed.success ? parsed.data : {};
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
