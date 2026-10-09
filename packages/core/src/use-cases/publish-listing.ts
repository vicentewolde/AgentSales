import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { Publication, PublicationActor } from "../publication.js";
import { PUBLISH_LISTING_PLATFORMS } from "../publish/input.js";
import {
  channelPublications,
  createPublications,
  planPublications,
  type SkippedPublication,
} from "./open-publications.js";
import {
  enqueuePublications,
  type PortalCheckDeps,
  portalDefinitionsBeforeLock,
  requireCompatibleMode,
  requireCurrentListingVersion,
  requireNoActiveRun,
  requirePortalPublishable,
  requirePublishableListing,
  STARTABLE_STATUSES,
  startOne,
} from "./publication-start.js";

export type PublishListingDeps = PortalCheckDeps & { lock: ListingLock; queue: JobQueue };

export type PublishListingResult = {
  /** Las que pasaron a `publishing` ahora. */
  started: Publication[];
  /** Las que ya estaban en `publishing` y se volvieron a encolar (por si su job se perdió). */
  requeued: Publication[];
  /** Las que nacieron ahora (la cuenta se conectó después de aprobar). */
  created: Publication[];
  /** Formatos que no se abrieron porque ya tenían una publicación activa de otro texto. */
  skipped: SkippedPublication[];
  /** Pendientes de una cuenta que ya no está conectada: no se publican (descartarlas o reconectar). */
  stranded: Publication[];
  /** Todas las publicaciones del canal del aviso, después de publicar (leídas en el candado). */
  publications: Publication[];
};

/**
 * Publica un canal de un aviso (spec F3 §4.3, `POST /listings/:id/publish`). Dentro del candado:
 * abre las publicaciones que falten (`openPublications`: la cuenta se conectó después de aprobar),
 * pasa a `publishing` las `approved` y `failed` del canal cuya cuenta sigue conectada, con el modo
 * de la API (`dryRun`, D11) y su evento, y junta las que ya estaban en `publishing`. **Después**,
 * ya confirmado, encola un `publication.publish` por cada una (las que estaban, de nuevo: es
 * idempotente, y así una cola caída a mitad de camino se arregla publicando otra vez). Todas las
 * revisiones van antes de la primera escritura. Errores (`AppError`, 409 salvo los "no existe"):
 * - el aviso no existe → `LISTING_NOT_FOUND` (404); no está en `ready` o `active` → `LISTING_NOT_READY`;
 * - hay una corrida activa (puede reemplazar los medios) → `CONTENT_RUN_ACTIVE`;
 * - el texto vigente del canal no está aprobado → `CONTENT_NOT_APPROVED`;
 * - el corredor no tiene una cuenta conectada en el canal, o lo único pendiente es de una cuenta
 *   desconectada → `ACCOUNT_NOT_CONNECTED`;
 * - una fallida que ya empezó en `live` y se pide en `dry-run` → `PUBLISH_MODE_LOCKED`;
 * - en Portal, si hay algo que pasar a `publishing`: el texto aprobado tiene errores según la
 *   revisión de hoy → `CONTENT_HAS_ERRORS`, o al aviso le falta lo que pide Portal →
 *   `PORTAL_NOT_READY` (con `details.issues`; spec F4 §4.5), o una que ya existía es de otra
 *   versión del aviso → `PUBLICATION_LISTING_CHANGED` (§4.6);
 * - no hay nada que iniciar ni reencolar → `NOTHING_TO_PUBLISH` (si un formato está ocupado por
 *   una publicación de un texto anterior, el mensaje dice que se retire o descarte primero);
 * - la cola no está → `QUEUE_UNAVAILABLE` (503), con las que quedaron sin job en
 *   `details.publicationIds`: siguen en `publishing` y se reencolan publicando otra vez o al
 *   arrancar el worker.
 */
export async function publishListing(
  deps: PublishListingDeps,
  {
    listingId,
    platform,
    dryRun,
    actor,
  }: { listingId: string; platform: Platform; dryRun: boolean; actor: PublicationActor },
): Promise<PublishListingResult> {
  const definitions = await portalDefinitionsBeforeLock(deps, listingId, platform);
  const result = await deps.lock.run(listingId, async (locked) => {
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
    const pending = channel.filter((publication) =>
      STARTABLE_STATUSES.includes(publication.status),
    );
    const startable = pending.filter((p) => connected.has(p.platformAccountId));
    const stranded = pending.filter((p) => !connected.has(p.platformAccountId));
    const inFlight = channel.filter((publication) => publication.status === "publishing");
    for (const publication of startable) requireCompatibleMode(publication, dryRun);
    if (startable.length === 0 && opening.toCreate.length === 0 && inFlight.length === 0) {
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
          : "No hay nada que publicar en este canal: todo está publicado",
        { details: { listingId, platform, skipped: opening.skipped } },
      );
    }

    // Primero la versión: con un aviso recargado, descartar y aprobar de nuevo es inevitable, y así
    // el operador no completa la planilla para recién después enterarse.
    if (PUBLISH_LISTING_PLATFORMS.has(platform)) {
      await requireCurrentListingVersion(locked, listing.id, startable);
    }
    if (definitions !== null && startable.length + opening.toCreate.length > 0) {
      await requirePortalPublishable(locked, { listing, content, definitions });
    }

    // Recién aquí se escribe.
    const created = await createPublications(locked, {
      listing,
      content,
      planned: opening.toCreate,
      actor,
    });
    const started: Publication[] = [];
    for (const publication of [...startable, ...created]) {
      started.push(await startOne(locked.publications, publication, { dryRun, actor }));
    }
    return {
      started,
      requeued: inFlight,
      created,
      skipped: opening.skipped,
      stranded,
      publications: await channelPublications(locked, listingId, platform),
    };
  });

  // Ya confirmado: encolar todas, también las que ya estaban en curso (idempotente).
  await enqueuePublications(deps.queue, [...result.started, ...result.requeued]);
  return result;
}
