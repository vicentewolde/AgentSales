import type {
  Publication,
  PublicationActor,
  PublicationEvent,
  SkippedPublication,
} from "@agentsales/core";
import type { Context } from "hono";
import {
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

export const eventView = (event: PublicationEvent): PublicationEventView => ({
  id: event.id,
  type: event.type,
  fromStatus: event.fromStatus,
  toStatus: event.toStatus,
  actor: event.actor,
  payload: event.payload,
  createdAt: event.createdAt,
});

/** Quién pide el cambio, para la bitácora: la CLI se identifica con `X-AgentSales-Client: cli`. */
export const actorOf = (c: Context): PublicationActor =>
  c.req.header(CLIENT_HEADER)?.trim().toLowerCase() === "cli" ? "cli" : "operator";
