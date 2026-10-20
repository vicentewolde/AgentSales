import type { Content } from "../content.js";
import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import { manualConfirmPending, requiresManualConfirm } from "../marketplace/limits.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import { canDraftPost, type Post, postNotReady } from "../post.js";
import type { Publication } from "../publication.js";
import { PUBLISH_LISTING_PLATFORMS } from "../publish/input.js";
import { outcomeUnknownPending } from "../publish/outcome.js";
import type { PostSubject } from "../subject.js";
import type { LockedSubject, SubjectLockedRepositories } from "../subject-lock.js";
import {
  channelPublications,
  type PlannedPostPublication,
  type PublicationOpening,
  planPostPublications,
  planPublications,
  type SkippedPublication,
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
// `publishPost`, `startPublication`), programar (F6, `schedule-publications.ts`) y el disparo de
// las programadas (`startDuePublications`): todas revisan lo mismo, dentro del candado de su
// sujeto (el del aviso o, desde F9-T07, el del post: ADR-0029 punto 4).

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
 * (`STARTABLE_STATUSES`), sobre su propio texto (spec F3 §4.3), dentro del candado de su sujeto
 * (`runOnSubject`, ADR-0029 punto 4):
 * - de un aviso: el aviso publicable, sin corridas, el texto aprobado, la cuenta conectada, el modo
 *   compatible y, según la plataforma, la versión del aviso, lo que pide Portal y lo que pide
 *   Marketplace;
 * - de un post: el post en `draft` o `ready` (`POST_NOT_READY`), sin corridas, el texto aprobado,
 *   la cuenta conectada y el modo compatible. Lo de Portal y Marketplace no aplica (un post nunca
 *   es de esas plataformas).
 * Los errores son los de `startPublication`; el estado de la publicación lo revisa quien llama.
 */
export async function requireStartableOne(
  locked: LockedSubject,
  publication: Publication,
  options: StartCheckOptions,
): Promise<void> {
  if (locked.kind === "post") {
    const post = await locked.repos.posts.get(locked.subject.id);
    if (post === null) throw postNotFound(locked.subject.id);
    if (!canDraftPost(post.status)) throw postNotReady(post);
    await requireNoActiveRun(locked.repos, locked.subject);
    await requireApprovedAndConnected(locked.repos, publication);
    requireCompatibleMode(publication, options.dryRun);
    return;
  }
  const repos = locked.repos;
  const listing = requirePublishableListing(
    await repos.listings.get(locked.subject.id),
    locked.subject.id,
  );
  await requireNoActiveRun(repos, locked.subject.id);
  const content = await requireApprovedAndConnected(repos, publication);
  requireCompatibleMode(publication, options.dryRun);
  if (PUBLISH_LISTING_PLATFORMS.has(publication.platform)) {
    await requireCurrentListingVersion(repos, listing.id, [publication]);
  }
  if (options.definitions !== null) {
    await requirePortalPublishable(repos, { listing, content, definitions: options.definitions });
  }
  if (requiresManualConfirm(publication.platform)) {
    await requireMarketplaceStartable(repos, {
      listing,
      accountIds: [publication.platformAccountId],
      channelIds: [publication.id],
      dryRun: options.dryRun,
      options: options.marketplace,
      now: options.now,
      limits: options.manualLimits,
    });
  }
}

/**
 * El texto de la publicación sigue aprobado y su cuenta, conectada (lo común de los dos sujetos).
 * Devuelve el texto.
 */
async function requireApprovedAndConnected(
  repos: Pick<SubjectLockedRepositories, "contents" | "platformAccounts">,
  publication: Publication,
): Promise<Content> {
  const content = await repos.contents.get(publication.contentId);
  if (content === null || content.status !== "approved") {
    throw new AppError(
      "CONTENT_NOT_APPROVED",
      "El texto de esta publicación ya no está aprobado: apruébalo de nuevo o descártala",
      { details: { publicationId: publication.id, contentId: publication.contentId } },
    );
  }
  const account = await repos.platformAccounts.get(publication.platformAccountId);
  if (account === null || account.status !== "connected") {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de esta publicación no está conectada: reconéctala o descártala",
      { details: { publicationId: publication.id, accountStatus: account?.status ?? null } },
    );
  }
  return content;
}

const postNotFound = (postId: string) =>
  new AppError("POST_NOT_FOUND", `No existe el post ${postId}`, { details: { postId } });

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
  // Una del canal con resultado dudoso (ADR-0029 punto 8) se resuelve antes, en cualquier red.
  const unknown = channel.find((p) => p.status === "outcome_unknown");
  if (unknown !== undefined) throw outcomeUnknownPending(unknown.id);
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

/** Lo que se abre de un canal de un post: por texto aprobado (un idioma), sus publicaciones. */
export type PostChannelOpening = {
  toCreate: { content: Content; planned: PlannedPostPublication[] }[];
  skipped: SkippedPublication[];
};

/** El canal de un post (una red, todos sus idiomas), revisado y listo para escribir. */
export type PostChannelStart = {
  post: Post;
  opening: PostChannelOpening;
  /** Las pendientes (`STARTABLE_STATUSES`) de cuentas conectadas. */
  startable: Publication[];
  /** Las pendientes de una cuenta que ya no está conectada: no se tocan. */
  stranded: Publication[];
  /** Las que ya están en `publishing`. */
  inFlight: Publication[];
};

/**
 * Las revisiones de publicar (o programar) un canal de un **post** (F9-T07, ADR-0029 punto 4),
 * dentro del candado del post y antes de la primera escritura: como `prepareChannelStart`, pero un
 * canal es una red con un texto por idioma (spec F9 §4.4) y no hay reglas de Portal ni de
 * Marketplace. Errores: el post no está en `draft` ni `ready` → `POST_NOT_READY`; corrida activa →
 * `CONTENT_RUN_ACTIVE`; ningún texto aprobado en esa red → `CONTENT_NOT_APPROVED`; sin cuenta
 * conectada (o lo pendiente es de una desconectada) → `ACCOUNT_NOT_CONNECTED`; una del canal con
 * resultado dudoso → `OUTCOME_UNKNOWN_PENDING`; una fallida que empezó en `live` pedida en
 * `dry-run` → `PUBLISH_MODE_LOCKED`; nada que hacer → `NOTHING_TO_PUBLISH` (si lo que queda espera
 * la confirmación de una publicación a mano, el mensaje lo dice y `details.publicationIds` las da).
 */
export async function preparePostChannelStart(
  locked: PostLockedRepositories,
  { subject, platform }: { subject: PostSubject; platform: Platform },
  options: Pick<StartCheckOptions, "dryRun"> & { countInFlight: boolean; nothingMessage: string },
): Promise<PostChannelStart> {
  const post = await locked.posts.get(subject.id);
  if (post === null) throw postNotFound(subject.id);
  if (!canDraftPost(post.status)) throw postNotReady(post);
  await requireNoActiveRun(locked, subject);
  const approved = (await locked.contents.listCurrent(subject)).filter(
    (content) => content.platform === platform && content.status === "approved",
  );
  if (approved.length === 0) {
    throw new AppError(
      "CONTENT_NOT_APPROVED",
      "El post no tiene un texto aprobado en esta red: apruébalo antes de publicar",
      { details: { postId: post.id, platform } },
    );
  }
  const connected = new Set(
    (await locked.platformAccounts.listByBroker(post.brokerId, platform))
      .filter((account) => account.status === "connected")
      .map((account) => account.id),
  );
  if (connected.size === 0) {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "No hay una cuenta conectada en esta red: conéctala antes de publicar",
      { details: { postId: post.id, platform } },
    );
  }
  const opening: PostChannelOpening = { toCreate: [], skipped: [] };
  for (const content of approved) {
    const planned = await planPostPublications(locked, { post, content });
    if (planned.toCreate.length > 0) opening.toCreate.push({ content, planned: planned.toCreate });
    opening.skipped.push(...planned.skipped);
  }
  const toCreate = opening.toCreate.reduce((sum, item) => sum + item.planned.length, 0);
  const channel = await channelPublications(locked, subject, platform);
  const pending = channel.filter((publication) => STARTABLE_STATUSES.includes(publication.status));
  const startable = pending.filter((p) => connected.has(p.platformAccountId));
  const stranded = pending.filter((p) => !connected.has(p.platformAccountId));
  const inFlight = channel.filter((publication) => publication.status === "publishing");
  for (const publication of startable) requireCompatibleMode(publication, options.dryRun);
  // Una del canal con resultado dudoso (ADR-0029 punto 8) se resuelve antes.
  const unknown = channel.find((p) => p.status === "outcome_unknown");
  if (unknown !== undefined) throw outcomeUnknownPending(unknown.id);
  const busy = options.countInFlight ? inFlight.length : 0;
  if (startable.length === 0 && toCreate === 0 && busy === 0) {
    if (stranded.length > 0) {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "Las publicaciones pendientes son de una cuenta desconectada: reconéctala o descártalas",
        { details: { postId: post.id, platform, publicationIds: stranded.map((p) => p.id) } },
      );
    }
    // Lo que queda espera la palabra del operador (una cuenta a mano, ADR-0029 punto 9).
    const waiting = channel.filter((p) => p.status === "awaiting_manual_confirm");
    if (waiting.length > 0) {
      throw new AppError(
        "NOTHING_TO_PUBLISH",
        "Las publicaciones de esta red esperan tu confirmación: di si las publicaste a mano (pega el enlace) o márcalas como no publicadas",
        { details: { postId: post.id, platform, publicationIds: waiting.map((p) => p.id) } },
      );
    }
    throw new AppError(
      "NOTHING_TO_PUBLISH",
      opening.skipped.length > 0
        ? "Ya hay una publicación de un texto anterior en esta red: retírala o descártala para publicar el texto nuevo"
        : options.nothingMessage,
      { details: { postId: post.id, platform, skipped: opening.skipped } },
    );
  }
  return { post, opening, startable, stranded, inFlight };
}
