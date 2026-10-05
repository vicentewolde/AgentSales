import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import {
  channelPublications,
  createPublications,
  planPublications,
  type SkippedPublication,
} from "./open-publications.js";

/** Estados del aviso en que se puede publicar (spec F3 §4.3): listo o ya publicado. */
const PUBLISHABLE_LISTING_STATUSES: readonly Listing["status"][] = ["ready", "active"];
/** Estados de una publicación que se pueden pasar a `publishing`. */
const STARTABLE: readonly Publication["status"][] = ["approved", "failed"];

/**
 * Encola el intento de una publicación. Con `singletonKey` (cola `exclusive`) es idempotente: lo
 * usan publicar, publicar una y el worker, que reencola todas las `publishing` al arrancar.
 */
export const enqueuePublication = (queue: JobQueue, publicationId: string) =>
  queue.enqueue("publication.publish", { publicationId }, { singletonKey: publicationId });

/** El modo de un intento para la bitácora (`publication_events`). */
const modeOf = (dryRun: boolean) => (dryRun ? "dry-run" : "live");

function requirePublishableListing(listing: Listing | null, listingId: string): Listing {
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
      details: { listingId },
    });
  }
  if (!PUBLISHABLE_LISTING_STATUSES.includes(listing.status)) {
    throw new AppError(
      "LISTING_NOT_READY",
      "La propiedad tiene que estar lista o publicada para publicar",
      { details: { listingId, status: listing.status } },
    );
  }
  return listing;
}

/** Pasa una publicación a `publishing` con el modo de la API y su evento (spec F3 §4.3, D11). */
function startOne(
  publications: LockedRepositories["publications"],
  publication: Publication,
  { dryRun, actor }: { dryRun: boolean; actor: PublicationActor },
): Promise<Publication> {
  return publications.transition(
    publication.id,
    {
      from: publication.status,
      to: "publishing",
      // El motivo del intento anterior se borra; `progress` se conserva para retomar.
      changes: { dryRun, incrementAttempts: true, lastError: null },
    },
    { actor, payload: { mode: modeOf(dryRun), attempt: publication.attempts + 1 } },
  );
}

export type PublishListingDeps = { lock: ListingLock; queue: JobQueue };

export type PublishListingResult = {
  /** Las que pasaron a `publishing` ahora (y se encolaron). */
  started: Publication[];
  /** Las que nacieron ahora (la cuenta se conectó después de aprobar). */
  created: Publication[];
  /** Formatos que no se abrieron porque ya tenían una publicación activa de otro texto. */
  skipped: SkippedPublication[];
  /** Todas las publicaciones del canal del aviso, después de publicar (leídas en el candado). */
  publications: Publication[];
};

/**
 * Publica un canal de un aviso (spec F3 §4.3, `POST /listings/:id/publish`). Dentro del candado:
 * abre las publicaciones que falten (`openPublications`: la cuenta se conectó después de aprobar)
 * y pasa a `publishing` las `approved` y `failed` del canal cuya cuenta sigue conectada, con el
 * modo de la API (`dryRun`, D11) y su evento. **Después**, ya confirmado, encola un
 * `publication.publish` por cada una. Todas las revisiones van antes de la primera escritura.
 * Errores (`AppError`, 409 salvo los "no existe"):
 * - el aviso no existe → `LISTING_NOT_FOUND` (404); no está en `ready` o `active` → `LISTING_NOT_READY`;
 * - hay una corrida activa (puede reemplazar los medios) → `CONTENT_RUN_ACTIVE`;
 * - el texto vigente del canal no está aprobado → `CONTENT_NOT_APPROVED`;
 * - el corredor no tiene una cuenta conectada en el canal, o las pendientes son de una cuenta
 *   desconectada → `ACCOUNT_NOT_CONNECTED`;
 * - no queda nada que pasar a `publishing` (todas publicadas o en curso) → `NOTHING_TO_PUBLISH`;
 * - la cola no está → `QUEUE_UNAVAILABLE` (503): las publicaciones quedan en `publishing` y el
 *   worker las reencola al arrancar (o se reencolan publicando una).
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
  const result = await deps.lock.run(listingId, async (locked) => {
    const listing = requirePublishableListing(await locked.listings.get(listingId), listingId);
    const active = await locked.contentRuns.findActive(listingId);
    if (active !== null) {
      throw new AppError(
        "CONTENT_RUN_ACTIVE",
        "Hay una preparación de contenido en curso: espera a que termine para publicar",
        { details: { listingId, contentRunId: active.id } },
      );
    }
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
    const connected = (await locked.platformAccounts.listByBroker(listing.brokerId, platform))
      .filter((account) => account.status === "connected")
      .map((account) => account.id);
    if (connected.length === 0) {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "No hay una cuenta conectada en este canal: conéctala antes de publicar",
        { details: { listingId, platform } },
      );
    }
    const opening = await planPublications(locked, { listing, content });
    const existing = (await channelPublications(locked, listingId, platform)).filter(
      (publication) => STARTABLE.includes(publication.status),
    );
    const startable = existing.filter((publication) =>
      connected.includes(publication.platformAccountId),
    );
    if (startable.length === 0 && opening.toCreate.length === 0) {
      if (existing.length > 0) {
        throw new AppError(
          "ACCOUNT_NOT_CONNECTED",
          "Las publicaciones pendientes son de una cuenta desconectada: reconéctala o descártalas",
          { details: { listingId, platform, publicationIds: existing.map((p) => p.id) } },
        );
      }
      throw new AppError(
        "NOTHING_TO_PUBLISH",
        "No hay nada que publicar en este canal: todo está publicado o en curso",
        { details: { listingId, platform, skipped: opening.skipped.length } },
      );
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
      created,
      skipped: opening.skipped,
      publications: await channelPublications(locked, listingId, platform),
    };
  });

  // Ya confirmado: encolar. Si la cola falla, quedan en `publishing` y el worker las reencola.
  for (const publication of result.started) {
    await enqueuePublication(deps.queue, publication.id);
  }
  return result;
}

export type StartPublicationDeps = {
  lock: ListingLock;
  queue: JobQueue;
  /** Fuera del candado: solo para saber de qué aviso es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

export type StartPublicationResult = {
  publication: Publication;
  /** `true` si ya estaba en `publishing`: se reencoló sin cambiarla (conserva su modo). */
  requeued: boolean;
};

/**
 * Publica o reintenta **una** publicación (spec F3 §4.3, `POST /publications/:id/publish`):
 * - `approved` o `failed` → `publishing`, con el modo de la API (`dryRun`) y su evento; un
 *   reintento desde `failed` conserva `progress` (para no publicar dos veces);
 * - ya en `publishing` → la reencola sin cambiarla (`requeued`): un corte en el último intento la
 *   dejaba sin job, como `requestContentRun`;
 * y encola después del candado. Errores (`AppError`):
 * - no existe → `PUBLICATION_NOT_FOUND` (404); el aviso no está en `ready` o `active` → `LISTING_NOT_READY`;
 * - su cuenta ya no está conectada → `ACCOUNT_NOT_CONNECTED`;
 * - ya está publicada → `NOTHING_TO_PUBLISH`; descartada o retirada → `INVALID_TRANSITION`.
 */
export async function startPublication(
  deps: StartPublicationDeps,
  {
    publicationId,
    dryRun,
    actor,
  }: { publicationId: string; dryRun: boolean; actor: PublicationActor },
): Promise<StartPublicationResult> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);

  const result = await deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status === "publishing") return { publication, requeued: true };
    if (publication.status === "published") {
      throw new AppError("NOTHING_TO_PUBLISH", "Esta publicación ya está publicada", {
        details: { publicationId },
      });
    }
    if (!STARTABLE.includes(publication.status)) {
      throw new AppError(
        "INVALID_TRANSITION",
        "Esta publicación no se puede publicar: se descartó o se retiró",
        { details: { publicationId, from: publication.status, to: "publishing" } },
      );
    }
    requirePublishableListing(
      await locked.listings.get(publication.listingId),
      publication.listingId,
    );
    const account = await locked.platformAccounts.get(publication.platformAccountId);
    if (account === null || account.status !== "connected") {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "La cuenta de esta publicación no está conectada: reconéctala o descártala",
        { details: { publicationId, accountStatus: account?.status ?? null } },
      );
    }
    return {
      publication: await startOne(locked.publications, publication, { dryRun, actor }),
      requeued: false,
    };
  });

  await enqueuePublication(deps.queue, result.publication.id);
  return result;
}

export const publicationNotFound = (publicationId: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${publicationId}`, {
    details: { publicationId },
  });
