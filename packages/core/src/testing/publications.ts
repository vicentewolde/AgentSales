import { DEFAULT_LANGUAGE } from "../enums.js";
import { AppError } from "../errors.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import { lockedMedia } from "../ports/media-repository.js";
import type {
  PublicationChanges,
  PublicationEventInput,
  PublicationRepository,
} from "../ports/publication-repository.js";
import {
  checkPublicationProgress,
  checkRemoteState,
  normalizeEventPayload,
  type Publication,
  type PublicationEvent,
  requirePublicationMode,
} from "../publication.js";
import {
  ACTIVE_PUBLICATION_STATUSES,
  canTransition,
  TERMINAL_PUBLICATION_STATUSES,
} from "../publication-state.js";
import { listingSubject, sameSubject, subjectFieldsFor, subjectOfInput } from "../subject.js";
import { COST_COUNTED_STATUSES } from "../x/cost.js";
import { structuredCopy } from "./copy.js";

export type InMemoryPublicationRepository = PublicationRepository & {
  /** Todas las publicaciones guardadas, para afirmar en los tests. */
  all(): Publication[];
  /**
   * Lo que hace `MetaDeletionRepository.eraseInstagramUser` con las publicaciones de una cuenta
   * (F8-T17): sin enlace, id externo ni progreso, en su estado, con un `data_deleted` cada una, y sin
   * el nombre de la cuenta en lo enviado de sus intentos. Devuelve cuántas tocó.
   */
  eraseExternalData(platformAccountId: string, event: PublicationEventInput): number;
};

const notFound = (id: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${id}`, {
    details: { publicationId: id },
  });

/** Doble en memoria de `PublicationRepository`, con la misma semántica que el de Drizzle. */
export function createInMemoryPublicationRepository(
  options: {
    /** El reloj de la bitácora (`created_at` de los eventos); por defecto, la hora actual. */
    now?: () => Date;
  } = {},
): InMemoryPublicationRepository {
  const clock = options.now ?? (() => new Date());
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
    { actor, userId, payload }: PublicationEventInput,
  ): PublicationEvent => {
    const event: PublicationEvent = {
      id: `event-${++nextEvent}`,
      publicationId,
      type,
      fromStatus,
      toStatus,
      actor,
      userId: userId ?? null,
      payload: normalizeEventPayload(payload),
      createdAt: clock(),
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
      const subject = subjectOfInput(input);
      const language = input.language ?? DEFAULT_LANGUAGE;
      // Como los únicos de Postgres: por aviso, cuenta y formato; por post, también por idioma.
      const clash = [...publications.values()].some(
        ({ publication }) =>
          sameSubject(publication.subject, subject) &&
          publication.platformAccountId === input.platformAccountId &&
          publication.format === input.format &&
          (subject.kind === "listing" || publication.language === language) &&
          ACTIVE_PUBLICATION_STATUSES.includes(publication.status),
      );
      if (clash) {
        throw new AppError(
          "PUBLICATION_CONFLICT",
          subject.kind === "listing"
            ? "Ya hay una publicación activa de ese aviso, cuenta y formato"
            : "Ya hay una publicación activa de ese post, cuenta, formato e idioma",
          {
            details:
              subject.kind === "listing"
                ? { listingId: subject.id, format: input.format }
                : { postId: subject.id, format: input.format, language },
          },
        );
      }
      const relistedFrom = input.relistedFrom ?? null;
      const relisted =
        relistedFrom !== null &&
        [...publications.values()].some(
          ({ publication }) =>
            publication.relistedFrom === relistedFrom && publication.status !== "cancelled",
        );
      if (relisted) {
        throw new AppError("PUBLICATION_CONFLICT", "Esa publicación ya se republicó", {
          details: { relistedFrom },
        });
      }
      const now = new Date();
      const publication: Publication = {
        // Con forma de uuid, como en Postgres: los datos del job `publication.publish` lo exigen.
        id: `00000000-0000-4000-8000-${String(++nextPublication).padStart(12, "0")}`,
        ...subjectFieldsFor(subject),
        platformAccountId: input.platformAccountId,
        platform: input.platform,
        format: input.format,
        language,
        contentId: input.contentId,
        mediaIds: [...input.mediaIds],
        status: "approved",
        scheduledAt: null,
        publishedAt: null,
        externalId: null,
        externalUrl: null,
        attempts: 0,
        lastError: null,
        dryRun: true,
        progress: null,
        remoteState: null,
        listingSourceHash: input.listingSourceHash || null,
        relistedFrom,
        costUsd: input.costUsd ?? null,
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
    async listBySubject(subject) {
      return ordered((publication) => sameSubject(publication.subject, subject));
    },
    async listByStatus(status) {
      // De avisos y de posts, como en Postgres (desde F9-T06).
      return ordered((publication) => publication.status === status);
    },
    async listDue({ now, since, excludePlatforms, limit }) {
      return [...publications.values()]
        .map(({ publication }) => publication)
        .filter(
          (publication) =>
            publication.status === "scheduled" &&
            publication.scheduledAt !== null &&
            publication.scheduledAt.getTime() <= now.getTime() &&
            publication.scheduledAt.getTime() >= since.getTime() &&
            !excludePlatforms.includes(publication.platform),
        )
        .sort(
          (a, b) =>
            (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((publication) => structuredCopy(publication));
    },
    async listStalePublishing({ before, excludePlatforms }) {
      return [...publications.values()]
        .map(({ publication }) => publication)
        .filter(
          (publication) =>
            publication.status === "publishing" &&
            publication.updatedAt.getTime() < before.getTime() &&
            !excludePlatforms.includes(publication.platform),
        )
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
        .map((publication) => structuredCopy(publication));
    },
    async listForTracking({ listingIds, postIds = [], since }) {
      const terminal: readonly Publication["status"][] = TERMINAL_PUBLICATION_STATUSES;
      const ofSubject = ({ subject }: Publication) =>
        subject.kind === "listing" ? listingIds.includes(subject.id) : postIds.includes(subject.id);
      // Como en Postgres: los avisos primero (por id), después los posts (por id).
      const order = ({ subject }: Publication) =>
        `${subject.kind === "listing" ? 0 : 1}:${subject.id}`;
      return [...publications.values()]
        .filter(
          ({ publication }) =>
            ofSubject(publication) &&
            (!terminal.includes(publication.status) ||
              publication.updatedAt.getTime() >= since.getTime()),
        )
        .sort(
          (a, b) =>
            order(a.publication).localeCompare(order(b.publication)) || a.sequence - b.sequence,
        )
        .map(({ publication }) => structuredCopy(publication));
    },
    async reschedule(id, { expectedAt, at, dryRun }, event) {
      normalizeEventPayload(event.payload);
      const found = find(id);
      if (
        found.publication.status !== "scheduled" ||
        found.publication.scheduledAt?.getTime() !== expectedAt.getTime()
      ) {
        throw new AppError(
          "INVALID_TRANSITION",
          "La publicación ya no está programada a esa hora: recarga y vuelve a intentarlo",
          { details: { publicationId: id, from: "scheduled", to: "scheduled" } },
        );
      }
      const publication = {
        ...found.publication,
        scheduledAt: new Date(at),
        dryRun,
        updatedAt: later(found.publication.updatedAt),
      };
      publications.set(id, { ...found, publication });
      pushEvent(id, "schedule_changed", null, null, event);
      return structuredCopy(publication);
    },
    async replacePublishedSource(id, guard, source, event) {
      const found = find(id);
      // Primero los datos y después el estado, como el de Drizzle.
      normalizeEventPayload(event.payload);
      const progress = checkPublicationProgress(found.publication.platform, source.progress);
      // La única excepción a "lo aprobado no cambia" (ADR-0020): Portal, publicada o pausada.
      if (
        found.publication.platform !== "portal_inmobiliario" ||
        (guard.from !== "published" && guard.from !== "paused")
      ) {
        throw new AppError(
          "INVALID_TRANSITION",
          "Solo un aviso de Portal publicado o pausado se actualiza en la plataforma",
          { details: { publicationId: id, from: guard.from } },
        );
      }
      if (found.publication.status !== guard.from) {
        throw new AppError("PUBLICATION_STALE", "La publicación cambió mientras tanto: recarga", {
          details: { publicationId: id },
        });
      }
      const publication = {
        ...found.publication,
        contentId: source.contentId,
        listingSourceHash: source.listingSourceHash || null,
        progress: structuredCopy(progress),
        updatedAt: later(found.publication.updatedAt),
      };
      publications.set(id, { ...found, publication });
      pushEvent(id, "manual_edit", null, null, event);
      return structuredCopy(publication);
    },
    async transition(id, { from, to, changes = {} }, event) {
      const found = find(id);
      // Primero los datos y después el estado, como el de Drizzle.
      normalizeEventPayload(event.payload);
      const publication = applyChanges(found.publication, to, changes);
      requirePublicationMode(to, changes);
      if (!canTransition(from, to) || found.publication.status !== from) {
        throw new AppError("INVALID_TRANSITION", `Transición inválida de ${from} a ${to}`, {
          details: { publicationId: id, from, to, current: found.publication.status },
        });
      }
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
        updatedAt: later(found.publication.updatedAt),
      };
      publications.set(id, { ...found, publication });
      return structuredCopy(publication);
    },
    async updateProgress(id, guard, progress) {
      const found = find(id);
      const checked = checkPublicationProgress(found.publication.platform, progress);
      if (
        found.publication.status !== guard.from ||
        found.publication.attempts !== guard.attempts
      ) {
        throw new AppError(
          "PUBLICATION_PROGRESS_STALE",
          "La publicación cambió: su progreso ya no es de ese intento",
          { details: { publicationId: id } },
        );
      }
      const publication = {
        ...found.publication,
        progress: structuredCopy(checked),
        updatedAt: later(found.publication.updatedAt),
      };
      publications.set(id, { ...found, publication });
      return structuredCopy(publication);
    },
    async setRemoteState(id, remoteState, event) {
      // Primero los datos, como el de Drizzle.
      const checked = checkRemoteState(remoteState);
      if (event !== undefined) normalizeEventPayload(event.payload);
      const found = find(id);
      const publication = {
        ...found.publication,
        remoteState: structuredCopy(checked),
        updatedAt: later(found.publication.updatedAt),
      };
      publications.set(id, { ...found, publication });
      if (event !== undefined) pushEvent(id, event.type, null, null, event);
      return structuredCopy(publication);
    },
    async addEvent(publicationId, event) {
      normalizeEventPayload(event.payload);
      find(publicationId);
      return pushEvent(publicationId, event.type, null, null, event);
    },
    async setCostUsd(id, costUsd) {
      const found = find(id);
      if (found.publication.status !== "publishing") {
        throw new AppError(
          "PUBLICATION_NOT_PUBLISHING",
          "La publicación ya no se está publicando",
          { details: { publicationId: id, status: found.publication.status } },
        );
      }
      const publication = {
        ...found.publication,
        costUsd: costUsd === null ? null : Math.round(costUsd * 10_000) / 10_000,
        updatedAt: later(found.publication.updatedAt),
      };
      publications.set(id, { ...found, publication });
      return structuredCopy(publication);
    },
    async sumCostUsdSince(platformAccountId, since, options = {}) {
      const counted: ReadonlySet<string> = new Set(COST_COUNTED_STATUSES);
      return [...publications.values()]
        .map(({ publication }) => publication)
        .filter(
          (publication) =>
            publication.platformAccountId === platformAccountId &&
            publication.id !== options.excludePublicationId &&
            !publication.dryRun &&
            publication.costUsd !== null &&
            counted.has(publication.status) &&
            (publication.publishedAt ?? publication.updatedAt).getTime() >= since.getTime(),
        )
        .reduce((sum, publication) => sum + (publication.costUsd ?? 0), 0);
    },
    async countLiveAttemptsSince(platformAccountId, since) {
      const own = new Set(
        [...publications.values()]
          .filter(({ publication }) => publication.platformAccountId === platformAccountId)
          .map(({ publication }) => publication.id),
      );
      return events.filter(
        (event) =>
          own.has(event.publicationId) &&
          event.type === "publish_attempt" &&
          event.payload.mode === "live" &&
          event.createdAt.getTime() >= since.getTime(),
      ).length;
    },
    async listEvents(publicationId) {
      return events
        .filter((event) => event.publicationId === publicationId)
        .map((event) => structuredCopy(event));
    },
    all() {
      return [...publications.values()].map(({ publication }) => structuredCopy(publication));
    },
    eraseExternalData(platformAccountId, event) {
      const own = [...publications.values()].filter(
        ({ publication }) => publication.platformAccountId === platformAccountId,
      );
      for (const found of own) {
        const { id } = found.publication;
        publications.set(id, {
          ...found,
          publication: {
            ...found.publication,
            externalId: null,
            externalUrl: null,
            progress: null,
            updatedAt: later(found.publication.updatedAt),
          },
        });
        for (const stored of events) {
          if (stored.publicationId !== id || stored.type !== "publish_attempt") continue;
          stored.payload = withoutSentAccountName(stored.payload);
        }
        pushEvent(id, "data_deleted", null, null, event);
      }
      return own.length;
    },
  };
}

/** Lo enviado de un intento sin el nombre de la cuenta (como `jsonb_set` en Postgres). */
function withoutSentAccountName(payload: Record<string, unknown>): Record<string, unknown> {
  const sent = payload.sent;
  if (typeof sent !== "object" || sent === null || Array.isArray(sent)) return payload;
  const account = (sent as Record<string, unknown>).account;
  if (typeof account !== "object" || account === null || Array.isArray(account)) return payload;
  // Como `jsonb_set(..., false)`: solo reemplaza un nombre que existe.
  if (!("displayName" in account)) return payload;
  return { ...payload, sent: { ...sent, account: { ...account, displayName: "" } } };
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
    // La hora programada solo vive en `scheduled` (ADR-0018): al salir se borra.
    scheduledAt:
      status === "scheduled" && changes.scheduledAt instanceof Date
        ? new Date(changes.scheduledAt)
        : null,
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
    ...(changes.remoteState === undefined
      ? {}
      : { remoteState: structuredCopy(checkRemoteState(changes.remoteState)) }),
    updatedAt: later(current.updatedAt),
  };
}

/**
 * El `updatedAt` de un cambio: siempre después del anterior, como `clock_timestamp()` en Postgres
 * (doc 02). Dos cambios en el mismo milisegundo no deben verse iguales: el sync (F4-T17) compara
 * `updatedAt` por igualdad para saber si la publicación cambió mientras leía.
 */
const later = (previous: Date) => new Date(Math.max(Date.now(), previous.getTime() + 1));

/**
 * Candado en memoria: serializa los `run` del mismo aviso (uno espera al anterior) y entrega los
 * repositorios que recibe. No deshace nada si `fn` falla: los tests de rollback son de PGlite.
 * No valida las referencias de `create` (aviso, cuenta, texto): eso lo prueba el de Drizzle.
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
        return await fn({ ...repos, media: lockedMedia(repos.media, listingSubject(listingId)) });
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
