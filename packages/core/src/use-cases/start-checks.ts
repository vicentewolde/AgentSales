import type { Content } from "../content.js";
import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import { manualConfirmPending, requiresManualConfirm } from "../marketplace/limits.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { Publication } from "../publication.js";
import { PUBLISH_LISTING_PLATFORMS } from "../publish/input.js";
import { listingIdOf } from "../subject.js";
import {
  channelPublications,
  type PublicationOpening,
  planPublications,
} from "./open-publications.js";
import {
  type MarketplaceStartOptions,
  requireCompatibleMode,
  requireCurrentListingVersion,
  requireMarketplaceStartable,
  requireNoActiveRun,
  requirePortalPublishable,
  requirePublishableListing,
  STARTABLE_STATUSES,
} from "./publication-start.js";

// Las revisiones de "empezar" una publicación, compartidas por publicar ahora (`publishListing`,
// `startPublication`), programar (F6, `schedule-publications.ts`) y el disparo de las programadas
// (`startDuePublications`): las cuatro revisan lo mismo, dentro del candado del aviso.

/** Lo que las revisiones necesitan además de los repositorios del candado. */
export type StartCheckOptions = {
  /** El modo con que la publicación saldría (la API al publicar o programar; la propia al disparar). */
  dryRun: boolean;
  /** Las definiciones de campos leídas antes del candado (`portalDefinitionsBeforeLock`); `null` fuera de Portal. */
  definitions: readonly FieldDefinition[] | null;
  marketplace: MarketplaceStartOptions;
  now: Date;
  /**
   * Si se revisan el límite del día y "un formulario a la vez" de Marketplace. Al programar no
   * (spec F6 §4.3: son del día en que se aprieta Publicar); al publicar sí.
   */
  manualLimits: boolean;
};

/**
 * Lo que se revisa antes de empezar (o programar) **una** publicación que se puede empezar
 * (`STARTABLE_STATUSES`), sobre su propio texto (spec F3 §4.3): el aviso publicable, sin corridas,
 * el texto aprobado, la cuenta conectada, el modo compatible y, según la plataforma, la versión del
 * aviso, lo que pide Portal y lo que pide Marketplace. Devuelve el aviso. Los errores son los de
 * `startPublication`; el estado de la publicación lo revisa quien llama.
 */
export async function requireStartableOne(
  locked: LockedRepositories,
  publication: Publication,
  options: StartCheckOptions,
): Promise<Listing> {
  const listing = requirePublishableListing(
    await locked.listings.get(listingIdOf(publication.subject)),
    listingIdOf(publication.subject),
  );
  await requireNoActiveRun(locked, listingIdOf(publication.subject));
  const content = await locked.contents.get(publication.contentId);
  if (content === null || content.status !== "approved") {
    throw new AppError(
      "CONTENT_NOT_APPROVED",
      "El texto de esta publicación ya no está aprobado: apruébalo de nuevo o descártala",
      { details: { publicationId: publication.id, contentId: publication.contentId } },
    );
  }
  const account = await locked.platformAccounts.get(publication.platformAccountId);
  if (account === null || account.status !== "connected") {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de esta publicación no está conectada: reconéctala o descártala",
      { details: { publicationId: publication.id, accountStatus: account?.status ?? null } },
    );
  }
  requireCompatibleMode(publication, options.dryRun);
  if (PUBLISH_LISTING_PLATFORMS.has(publication.platform)) {
    await requireCurrentListingVersion(locked, listing.id, [publication]);
  }
  if (options.definitions !== null) {
    await requirePortalPublishable(locked, { listing, content, definitions: options.definitions });
  }
  if (requiresManualConfirm(publication.platform)) {
    await requireMarketplaceStartable(locked, {
      listing,
      accountIds: [publication.platformAccountId],
      channelIds: [publication.id],
      dryRun: options.dryRun,
      options: options.marketplace,
      now: options.now,
      limits: options.manualLimits,
    });
  }
  return listing;
}

/** El canal de un aviso, revisado y listo para escribir (spec F3 §4.3). */
export type ChannelStart = {
  listing: Listing;
  content: Content;
  /** Las que hay que crear (la cuenta se conectó después de aprobar) y los formatos ocupados. */
  opening: PublicationOpening;
  /** Las pendientes (`STARTABLE_STATUSES`) de cuentas conectadas. */
  startable: Publication[];
  /** Las pendientes de una cuenta que ya no está conectada: no se tocan. */
  stranded: Publication[];
  /** Las que ya están en `publishing`. */
  inFlight: Publication[];
};

/**
 * Las revisiones de publicar (o programar) un canal de un aviso, dentro del candado y antes de la
 * primera escritura (spec F3 §4.3): las de `publishListing`. Con `countInFlight` en falso (al
 * programar), las que ya se están publicando no cuentan como "algo que hacer".
 */
export async function prepareChannelStart(
  locked: LockedRepositories,
  { listingId, platform }: { listingId: string; platform: Platform },
  options: StartCheckOptions & { countInFlight: boolean; nothingMessage: string },
): Promise<ChannelStart> {
  const listing = requirePublishableListing(await locked.listings.get(listingId), listingId);
  await requireNoActiveRun(locked, listingId);
  const content = (await locked.contents.listCurrent(listingId)).find(
    (current) => current.platform === platform,
  );
  if (content === undefined || content.status !== "approved") {
    throw new AppError(
      "CONTENT_NOT_APPROVED",
      "El texto de este canal no está aprobado: apruébalo antes de publicar",
      { details: { listingId, platform, status: content?.status ?? null } },
    );
  }
  const connected = new Set(
    (await locked.platformAccounts.listByBroker(listing.brokerId, platform))
      .filter((account) => account.status === "connected")
      .map((account) => account.id),
  );
  if (connected.size === 0) {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "No hay una cuenta conectada en este canal: conéctala antes de publicar",
      { details: { listingId, platform } },
    );
  }
  const opening = await planPublications(locked, { listing, content });
  const channel = await channelPublications(locked, listingId, platform);
  const pending = channel.filter((publication) => STARTABLE_STATUSES.includes(publication.status));
  const startable = pending.filter((p) => connected.has(p.platformAccountId));
  const stranded = pending.filter((p) => !connected.has(p.platformAccountId));
  const inFlight = channel.filter((publication) => publication.status === "publishing");
  for (const publication of startable) requireCompatibleMode(publication, options.dryRun);
  const manual = requiresManualConfirm(platform);
  // Marketplace: una que espera el clic final se resuelve antes (spec F5 §4.3).
  const waiting = channel.find((p) => p.status === "awaiting_manual_confirm");
  if (manual && waiting !== undefined) throw manualConfirmPending(waiting.id);
  const busy = options.countInFlight ? inFlight.length : 0;
  if (startable.length === 0 && opening.toCreate.length === 0 && busy === 0) {
    if (stranded.length > 0) {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "Las publicaciones pendientes son de una cuenta desconectada: reconéctala o descártalas",
        { details: { listingId, platform, publicationIds: stranded.map((p) => p.id) } },
      );
    }
    throw new AppError(
      "NOTHING_TO_PUBLISH",
      opening.skipped.length > 0
        ? "Ya hay una publicación de un texto anterior en este canal: retírala o descártala para publicar el texto nuevo"
        : options.nothingMessage,
      { details: { listingId, platform, skipped: opening.skipped } },
    );
  }

  // Primero la versión: con un aviso recargado, descartar y aprobar de nuevo es inevitable, y así
  // el operador no completa la planilla para recién después enterarse.
  if (PUBLISH_LISTING_PLATFORMS.has(platform)) {
    await requireCurrentListingVersion(locked, listing.id, startable);
  }
  if (options.definitions !== null && startable.length + opening.toCreate.length > 0) {
    await requirePortalPublishable(locked, {
      listing,
      content,
      definitions: options.definitions,
    });
  }
  if (manual && startable.length + opening.toCreate.length > 0) {
    await requireMarketplaceStartable(locked, {
      listing,
      accountIds: [...connected],
      channelIds: channel.map((publication) => publication.id),
      dryRun: options.dryRun,
      options: options.marketplace,
      now: options.now,
      limits: options.manualLimits,
    });
  }
  return { listing, content, opening, startable, stranded, inFlight };
}
