import { PLATFORMS, type Platform } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  dateIn,
  MARKETPLACE_TIME_ZONE,
  manualConfirmPending,
  requiresManualConfirm,
} from "../marketplace/limits.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor, ScheduleReason } from "../publication.js";
import { scheduleAt as checkScheduleAt, MAX_SCHEDULE_SPACING_MINUTES } from "../schedule.js";
import { channelPublications, createPublications } from "./open-publications.js";
import {
  type MarketplaceStartOptions,
  modeOf,
  type PortalCheckDeps,
  portalDefinitionsBeforeLock,
  publicationNotFound,
  STARTABLE_STATUSES,
} from "./publication-start.js";
import { prepareChannelStart, requireStartableOne } from "./start-checks.js";

// Programar, reprogramar y desprogramar (spec F6 §4.3, ADR-0018). Lo programado vive en la base:
// nada se encola aquí. El disparo de cada minuto (`startDuePublications`) lo empieza a la hora.

export type ScheduleDeps = PortalCheckDeps & {
  lock: ListingLock;
  /** Marketplace: si se puede convertir la UF (lo que falta al aviso). */
  marketplace?: MarketplaceStartOptions;
  now?: () => Date;
  /** Fuera del candado: solo para saber de qué aviso es la publicación. */
  publications: Pick<PublicationRepository, "get">;
};

/** Cuántos recordatorios de Marketplace por cuenta y día se avisan en un lote (el límite, D8 de F5). */
const MARKETPLACE_REMINDERS_PER_DAY = 3;
/** Cuántas propiedades caben en un lote. */
export const MAX_SCHEDULE_BATCH = 50;

/**
 * Programa (o reprograma) una publicación ya revisada, dentro del candado:
 * - `approved` o `failed` → `scheduled` con la hora y el modo, y el evento con el motivo;
 * - ya `scheduled` → `reschedule` con `schedule_changed` (la hora y el modo de nuevo); a la misma
 *   hora y en el mismo modo, no cambia nada.
 */
async function scheduleOne(
  publications: LockedRepositories["publications"],
  publication: Publication,
  {
    at,
    dryRun,
    actor,
    reason,
  }: { at: Date; dryRun: boolean; actor: PublicationActor; reason: ScheduleReason },
): Promise<Publication> {
  if (publication.status === "scheduled" && publication.scheduledAt !== null) {
    if (publication.scheduledAt.getTime() === at.getTime() && publication.dryRun === dryRun) {
      return publication;
    }
    return publications.reschedule(
      publication.id,
      { expectedAt: publication.scheduledAt, at, dryRun },
      {
        actor,
        payload: {
          from: publication.scheduledAt.toISOString(),
          to: at.toISOString(),
          mode: modeOf(dryRun),
        },
      },
    );
  }
  return publications.transition(
    publication.id,
    { from: publication.status, to: "scheduled", changes: { dryRun, scheduledAt: at } },
    { actor, payload: { mode: modeOf(dryRun), scheduledAt: at.toISOString(), reason } },
  );
}

/**
 * Programa o reprograma **una** publicación (`POST /publications/:id/schedule`): `approved`,
 * `failed` o `scheduled`, con la misma revisión que publicarla (`startPublication`), salvo el
 * límite del día y "un formulario a la vez" de Marketplace (spec F6 §4.3). El modo es el de la API
 * (`dryRun`). Errores: los de publicar, más `SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR` y
 * `SCHEDULE_AT_INVALID` (400); una en `publishing` → `PUBLICATION_IN_PROGRESS`.
 */
export async function schedulePublication(
  deps: ScheduleDeps,
  {
    publicationId,
    at,
    dryRun,
    actor,
  }: { publicationId: string; at: Date; dryRun: boolean; actor: PublicationActor },
): Promise<Publication> {
  const now = (deps.now ?? (() => new Date()))();
  const when = checkScheduleAt(at, now);
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  const definitions = await portalDefinitionsBeforeLock(deps, found.listingId, found.platform);

  return deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status === "publishing") {
      throw new AppError(
        "PUBLICATION_IN_PROGRESS",
        "Esta publicación se está publicando: espera a que termine",
        { details: { publicationId } },
      );
    }
    if (publication.status === "awaiting_manual_confirm") throw manualConfirmPending(publicationId);
    if (publication.status === "published") {
      throw new AppError("NOTHING_TO_PUBLISH", "Esta publicación ya está publicada", {
        details: { publicationId },
      });
    }
    if (!STARTABLE_STATUSES.includes(publication.status)) {
      throw new AppError(
        "INVALID_TRANSITION",
        "Esta publicación no se puede programar: se descartó o se retiró",
        { details: { publicationId, from: publication.status, to: "scheduled" } },
      );
    }
    await requireStartableOne(locked, publication, {
      dryRun,
      definitions,
      marketplace: deps.marketplace ?? {},
      now,
      manualLimits: false,
    });
    return scheduleOne(locked.publications, publication, {
      at: when,
      dryRun,
      actor,
      reason: "operator",
    });
  });
}

/** Lo que programar un canal hizo, dentro del candado. */
export type ChannelScheduled = {
  /** Las que quedaron programadas (nuevas, desde `approved` o `failed`, o reprogramadas). */
  scheduled: Publication[];
  /** Las que nacieron ahora (la cuenta se conectó después de aprobar). */
  created: Publication[];
};

/**
 * Programa un canal de un aviso: como `publishListing`, abre las que faltan y programa todas las
 * pendientes de cuentas conectadas a la misma hora (el worker las publica de a una). Las que ya se
 * están publicando no cuentan. Lo usan `scheduleListings` y `auto_publish` (F6-T09, con `minLead`
 * en falso: el recordatorio de Marketplace es para ahora).
 */
export async function scheduleChannel(
  deps: Omit<ScheduleDeps, "publications">,
  {
    listingId,
    platform,
    at,
    dryRun,
    actor,
    reason,
    minLead = true,
  }: {
    listingId: string;
    platform: Platform;
    at: Date;
    dryRun: boolean;
    actor: PublicationActor;
    reason: ScheduleReason;
    minLead?: boolean;
  },
): Promise<ChannelScheduled> {
  const now = (deps.now ?? (() => new Date()))();
  const when = checkScheduleAt(at, now, { minLead });
  const definitions = await portalDefinitionsBeforeLock(deps, listingId, platform);
  return deps.lock.run(listingId, async (locked) => {
    const { listing, content, opening, startable } = await prepareChannelStart(
      locked,
      { listingId, platform },
      {
        dryRun,
        definitions,
        marketplace: deps.marketplace ?? {},
        now,
        manualLimits: false,
        countInFlight: false,
        nothingMessage:
          "No hay nada que programar en este canal: todo está publicado o publicándose",
      },
    );
    // Recién aquí se escribe.
    const created = await createPublications(locked, {
      listing,
      content,
      planned: opening.toCreate,
      actor,
    });
    const scheduled: Publication[] = [];
    for (const publication of [...startable, ...created]) {
      scheduled.push(
        await scheduleOne(locked.publications, publication, { at: when, dryRun, actor, reason }),
      );
    }
    // Las del canal, releídas: el resultado muestra la hora y el modo guardados.
    const ids = new Set(scheduled.map((publication) => publication.id));
    return {
      scheduled: (await channelPublications(locked, listingId, platform)).filter((publication) =>
        ids.has(publication.id),
      ),
      created,
    };
  });
}

/** El resultado de programar una propiedad en un canal, dentro de un lote. */
export type ScheduleListingOutcome =
  | {
      listingId: string;
      platform: Platform;
      outcome: "scheduled";
      at: Date;
      publications: Publication[];
    }
  | {
      listingId: string;
      platform: Platform | null;
      outcome: "skipped";
      code: string;
      message: string;
    };

export type ScheduleListingsResult = {
  results: ScheduleListingOutcome[];
  /** Avisos que no bloquearon (más de 3 recordatorios de Marketplace por cuenta y día). */
  notes: string[];
};

/** Sin canal pedido, estos no se informan: el canal simplemente no se usa en esa propiedad. */
const SILENT_WITHOUT_PLATFORMS = new Set(["CONTENT_NOT_APPROVED", "ACCOUNT_NOT_CONNECTED"]);

/**
 * Programa una o varias propiedades (`POST /schedule`, spec F6 §4.3): para cada una, en el orden
 * recibido, cada canal pedido (o, sin `platforms`, cada canal con texto aprobado y cuenta
 * conectada), a `at + i × spacingMinutes`. Una propiedad o un canal que no se puede programar no
 * corta el lote: queda `skipped` con su código y motivo. La hora se revisa una vez, para la primera
 * (y la última no puede pasar de 60 días). Errores del pedido: `SCHEDULE_BATCH_INVALID` (lista
 * vacía, repetida, más de 50, o un espaciado fuera de 0 a 240) y los de la hora.
 */
export async function scheduleListings(
  deps: Omit<ScheduleDeps, "publications">,
  {
    listingIds,
    platforms,
    at,
    spacingMinutes = 0,
    dryRun,
    actor,
  }: {
    listingIds: readonly string[];
    platforms?: readonly Platform[];
    at: Date;
    spacingMinutes?: number;
    dryRun: boolean;
    actor: PublicationActor;
  },
): Promise<ScheduleListingsResult> {
  if (
    listingIds.length === 0 ||
    listingIds.length > MAX_SCHEDULE_BATCH ||
    new Set(listingIds).size !== listingIds.length ||
    !Number.isInteger(spacingMinutes) ||
    spacingMinutes < 0 ||
    spacingMinutes > MAX_SCHEDULE_SPACING_MINUTES
  ) {
    throw new AppError(
      "SCHEDULE_BATCH_INVALID",
      `Un lote lleva de 1 a ${MAX_SCHEDULE_BATCH} propiedades distintas y un espaciado de 0 a ${MAX_SCHEDULE_SPACING_MINUTES} minutos`,
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  const first = checkScheduleAt(at, now);
  checkScheduleAt(
    new Date(first.getTime() + (listingIds.length - 1) * spacingMinutes * 60_000),
    now,
  );
  const asked = platforms !== undefined && platforms.length > 0;
  const channels = asked ? [...new Set(platforms)] : [...PLATFORMS];

  const results: ScheduleListingOutcome[] = [];
  for (const [index, listingId] of listingIds.entries()) {
    const when = new Date(first.getTime() + index * spacingMinutes * 60_000);
    let any = false;
    for (const platform of channels) {
      try {
        const done = await scheduleChannel(deps, {
          listingId,
          platform,
          at: when,
          dryRun,
          actor,
          reason: listingIds.length > 1 ? "batch" : "operator",
        });
        results.push({
          listingId,
          platform,
          outcome: "scheduled",
          at: when,
          publications: done.scheduled,
        });
        any = true;
      } catch (error) {
        if (!isAppError(error)) throw error;
        if (!asked && SILENT_WITHOUT_PLATFORMS.has(error.code)) continue;
        results.push({
          listingId,
          platform,
          outcome: "skipped",
          code: error.code,
          message: error.message,
        });
        any = true;
      }
    }
    if (!any) {
      results.push({
        listingId,
        platform: null,
        outcome: "skipped",
        code: "NOTHING_TO_PUBLISH",
        message: "La propiedad no tiene canales con el texto aprobado y la cuenta conectada",
      });
    }
  }
  return { results, notes: marketplaceReminderNotes(results) };
}

/** Más de 3 recordatorios de Marketplace de una cuenta para un mismo día de Chile: se avisa. */
export function marketplaceReminderNotes(results: readonly ScheduleListingOutcome[]): string[] {
  const perDay = new Map<string, number>();
  for (const result of results) {
    if (result.outcome !== "scheduled" || !requiresManualConfirm(result.platform)) continue;
    for (const publication of result.publications) {
      const key = `${publication.platformAccountId}:${dateIn(MARKETPLACE_TIME_ZONE, result.at)}`;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
  }
  const days = [...perDay.entries()]
    .filter(([, count]) => count > MARKETPLACE_REMINDERS_PER_DAY)
    .map(([key]) => key.slice(key.indexOf(":") + 1));
  return [...new Set(days)].map(
    (day) =>
      `El ${day} hay más de ${MARKETPLACE_REMINDERS_PER_DAY} recordatorios de Marketplace de una misma cuenta: Facebook acepta ${MARKETPLACE_REMINDERS_PER_DAY} formularios por día`,
  );
}

/**
 * Desprograma una publicación (`POST /publications/:id/unschedule`): `scheduled` → `approved`, sin
 * tocar su texto (sigue aprobado). Otra cosa → `INVALID_TRANSITION`.
 */
export async function unschedulePublication(
  deps: { lock: ListingLock; publications: Pick<PublicationRepository, "get"> },
  { publicationId, actor }: { publicationId: string; actor: PublicationActor },
): Promise<Publication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  return deps.lock.run(found.listingId, async (locked) => {
    const publication = await locked.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status !== "scheduled") {
      throw new AppError("INVALID_TRANSITION", "Esta publicación no está programada", {
        details: { publicationId, from: publication.status, to: "approved" },
      });
    }
    return locked.publications.transition(
      publicationId,
      { from: "scheduled", to: "approved" },
      { actor, payload: { unscheduled: publication.scheduledAt?.toISOString() ?? null } },
    );
  });
}
