import { AppError } from "../errors.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type {
  PublicationChanges,
  PublicationEventInput,
  PublicationRepository,
} from "../ports/publication-repository.js";
import {
  checkPublicationProgress,
  normalizeEventPayload,
  type Publication,
  type PublicationEvent,
} from "../publication.js";
import { ACTIVE_PUBLICATION_STATUSES, canTransition } from "../publication-state.js";
import { structuredCopy } from "./copy.js";

export type InMemoryPublicationRepository = PublicationRepository & {
  /** Todas las publicaciones guardadas, para afirmar en los tests. */
  all(): Publication[];
};

const notFound = (id: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${id}`, {
    details: { publicationId: id },
  });

/** Doble en memoria de `PublicationRepository`, con la misma semántica que el de Drizzle. */
export function createInMemoryPublicationRepository(): InMemoryPublicationRepository {
  let nextPublication = 0;
  let nextEvent = 0;
  const publications = new Map<string, { sequence: number; publication: Publication }>();
  const events: PublicationEvent[] = [];

  const find = (id: string) => {
    const found = publications.get(id);
    if (found === undefined) throw notFound(id);
    return found;
  };
  const pushEvent = (
    publicationId: string,
    type: PublicationEvent["type"],
    fromStatus: PublicationEvent["fromStatus"],
    toStatus: PublicationEvent["toStatus"],
    { actor, payload }: PublicationEventInput,
  ): PublicationEvent => {
    const event: PublicationEvent = {
      id: `event-${++nextEvent}`,
      publicationId,
      type,
      fromStatus,
      toStatus,
      actor,
      payload: normalizeEventPayload(payload),
      createdAt: new Date(),
    };
    events.push(event);
    return structuredCopy(event);
  };
  const ordered = (filter: (publication: Publication) => boolean) =>
    [...publications.values()]
      .filter(({ publication }) => filter(publication))
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ publication }) => structuredCopy(publication));

  return {
    async create(input, event) {
      normalizeEventPayload(event.payload);
      const clash = [...publications.values()].some(
        ({ publication }) =>
          publication.listingId === input.listingId &&
          publication.platformAccountId === input.platformAccountId &&
          publication.format === input.format &&
          ACTIVE_PUBLICATION_STATUSES.includes(publication.status),
      );
      if (clash) {
        throw new AppError(
          "PUBLICATION_CONFLICT",
          "Ya hay una publicación activa de ese aviso, cuenta y formato",
          { details: { listingId: input.listingId, format: input.format } },
        );
      }
      const now = new Date();
      const publication: Publication = {
        id: `publication-${++nextPublication}`,
        listingId: input.listingId,
        platformAccountId: input.platformAccountId,
        platform: input.platform,
        format: input.format,
        contentId: input.contentId,
        mediaIds: [...input.mediaIds],
        status: "approved",
        scheduledAt: null,
        publishedAt: null,
        externalId: null,
        externalUrl: null,
        attempts: 0,
        lastError: null,
        dryRun: input.dryRun,
        progress: null,
        createdAt: now,
        updatedAt: now,
      };
      publications.set(publication.id, { sequence: nextPublication, publication });
      pushEvent(publication.id, "status_changed", null, "approved", event);
      return structuredCopy(publication);
    },
    async get(id) {
      const found = publications.get(id);
      return found === undefined ? null : structuredCopy(found.publication);
    },
    async listByListing(listingId) {
      return ordered((publication) => publication.listingId === listingId);
    },
    async listByStatus(status) {
      return ordered((publication) => publication.status === status);
    },
    async transition(id, { from, to, changes = {} }, event) {
      const found = find(id);
      if (!canTransition(from, to) || found.publication.status !== from) {
        throw new AppError("INVALID_TRANSITION", `Transición inválida de ${from} a ${to}`, {
          details: { publicationId: id, from, to, current: found.publication.status },
        });
      }
      normalizeEventPayload(event.payload);
      const publication = applyChanges(found.publication, to, changes);
      publications.set(id, { ...found, publication });
      pushEvent(id, "status_changed", from, to, event);
      return structuredCopy(publication);
    },
    async saveProgress(id, progress) {
      const found = find(id);
      const checked = checkPublicationProgress(found.publication.platform, progress);
      if (found.publication.status !== "publishing") {
        throw new AppError(
          "PUBLICATION_NOT_PUBLISHING",
          "La publicación ya no se está publicando",
          { details: { publicationId: id, status: found.publication.status } },
        );
      }
      const publication = {
        ...found.publication,
        progress: structuredCopy(checked),
        updatedAt: new Date(),
      };
      publications.set(id, { ...found, publication });
      return structuredCopy(publication);
    },
    async addEvent(publicationId, event) {
      find(publicationId);
      return pushEvent(publicationId, event.type, null, null, event);
    },
    async listEvents(publicationId) {
      return events
        .filter((event) => event.publicationId === publicationId)
        .map((event) => structuredCopy(event));
    },
    all() {
      return [...publications.values()].map(({ publication }) => structuredCopy(publication));
    },
  };
}

/** Los cambios de una transición sobre la publicación (lo mismo que escribe el de Drizzle). */
function applyChanges(
  current: Publication,
  status: Publication["status"],
  changes: PublicationChanges,
): Publication {
  return {
    ...current,
    status,
    ...(changes.dryRun === undefined ? {} : { dryRun: changes.dryRun }),
    ...(changes.incrementAttempts ? { attempts: current.attempts + 1 } : {}),
    ...(changes.externalId === undefined ? {} : { externalId: changes.externalId }),
    ...(changes.externalUrl === undefined ? {} : { externalUrl: changes.externalUrl }),
    ...(changes.publishedAt === undefined
      ? {}
      : { publishedAt: changes.publishedAt === null ? null : new Date(changes.publishedAt) }),
    ...(changes.lastError === undefined
      ? {}
      : { lastError: changes.lastError === null ? null : { ...changes.lastError } }),
    ...(changes.progress === undefined
      ? {}
      : { progress: structuredCopy(checkPublicationProgress(current.platform, changes.progress)) }),
    updatedAt: new Date(),
  };
}

/**
 * Candado en memoria: serializa los `run` del mismo aviso (uno espera al anterior) y entrega los
 * repositorios que recibe. No deshace nada si `fn` falla: los tests de rollback son de PGlite.
 */
export function createInMemoryListingLock(repos: LockedRepositories): ListingLock & {
  /** Avisos con un `run` en curso, para afirmar en los tests de concurrencia. */
  busy(): string[];
} {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async run(listingId, fn) {
      const previous = tails.get(listingId) ?? Promise.resolve();
      let release: () => void = () => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(listingId, tail);
      await previous;
      try {
        if ((await repos.listings.get(listingId)) === null) {
          throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
            details: { listingId },
          });
        }
        return await fn(repos);
      } finally {
        release();
        if (tails.get(listingId) === tail) tails.delete(listingId);
      }
    },
    busy() {
      return [...tails.keys()];
    },
  };
}
