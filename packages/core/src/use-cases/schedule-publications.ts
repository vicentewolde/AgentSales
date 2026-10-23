import { LISTING_PLATFORMS, type Platform, POST_PLATFORMS } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  dateIn,
  MARKETPLACE_TIME_ZONE,
  manualConfirmPending,
  requiresManualConfirm,
} from "../marketplace/limits.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import {
  type Publication,
  type PublicationActor,
  type ScheduleReason,
  scheduleChangedPayloadSchema,
  scheduledPayloadSchema,
} from "../publication.js";
import { outcomeUnknownPending } from "../publish/outcome.js";
import { scheduleAt as checkScheduleAt, MAX_SCHEDULE_SPACING_MINUTES } from "../schedule.js";
import { listingSubject, type PostSubject, postSubject } from "../subject.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import {
  channelPublications,
  createPostPublications,
  createPublications,
} from "./open-publications.js";
import {
  type MarketplaceStartOptions,
  modeOf,
  type PortalCheckDeps,
  portalDefinitionsBeforeLock,
  publicationNotFound,
  STARTABLE_STATUSES,
  subjectDefinitionsBeforeLock,
} from "./publication-start.js";
import {
  prepareChannelStart,
  preparePostChannelStart,
  requireStartableOne,
} from "./start-checks.js";

// Programar, reprogramar y desprogramar (spec F6 §4.3, ADR-0018). Lo programado vive en la base:
// nada se encola aquí. El disparo de cada minuto (`startDuePublications`) lo empieza a la hora.

/** `postLock` hace falta para programar un post (sin él, `SUBJECT_NOT_LISTING`). */
export type ScheduleDeps = PortalCheckDeps &
  SubjectLocks & {
    /** Marketplace: si se puede convertir la UF (lo que falta al aviso). */
    marketplace?: MarketplaceStartOptions;
    now?: () => Date;
    /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
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
        payload: scheduleChangedPayloadSchema.parse({
          from: publication.scheduledAt.toISOString(),
          to: at.toISOString(),
          mode: modeOf(dryRun),
        }),
      },
    );
  }
  return publications.transition(
    publication.id,
    { from: publication.status, to: "scheduled", changes: { dryRun, scheduledAt: at } },
    {
      actor,
      payload: scheduledPayloadSchema.parse({
        mode: modeOf(dryRun),
        scheduledAt: at.toISOString(),
        reason,
      }),
    },
  );
}

/**
 * Programa o reprograma **una** publicación (`POST /publications/:id/schedule`): `approved`,
 * `failed` o `scheduled`, con la misma revisión que publicarla (`startPublication`), salvo el
 * límite del día y "un formulario a la vez" de Marketplace (spec F6 §4.3). El modo es el de la API
 * (`dryRun`). Dentro del candado de su sujeto: el del aviso o el del post (F9-T07; un post no
 * tiene las revisiones de Portal ni de Marketplace). Errores: los de publicar, más
 * `SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR` y `SCHEDULE_AT_INVALID` (400); una en `publishing` →
 * `PUBLICATION_IN_PROGRESS`; con resultado dudoso → `OUTCOME_UNKNOWN_PENDING`.
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
  const definitions = await subjectDefinitionsBeforeLock(deps, found.subject, found.platform);

  return runOnSubject(deps, found.subject, async (locked) => {
    const publication = await locked.repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status === "publishing") {
      throw new AppError(
        "PUBLICATION_IN_PROGRESS",
        "Esta publicación se está publicando: espera a que termine",
        { details: { publicationId } },
      );
    }
    if (publication.status === "awaiting_manual_confirm")
      throw manualConfirmPending(publicationId, publication.platform);
    // No se sabe si salió (ADR-0029 punto 8): programarla podría publicarla dos veces.
    if (publication.status === "outcome_unknown") throw outcomeUnknownPending(publicationId);
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
    return scheduleOne(locked.repos.publications, publication, {
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
 * están publicando no cuentan. Como en `publishListing`, si una escritura falla a mitad del canal
 * (otro cambio llegó primero), lo ya escrito queda escrito: el candado en memoria no deshace, y en
 * Postgres la transacción del candado sí lo revierte. Lo usan `scheduleListings` y `auto_publish` (F6-T09, con `minLead`
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
      scheduled: (await channelPublications(locked, listingSubject(listingId), platform)).filter(
        (publication) => ids.has(publication.id),
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
 * vacía, repetida, más de 50, o un espaciado fuera de 0 a 240), los de la hora y cualquier error
 * reintentable (la base: corta el lote con lo ya programado escrito, en vez de informarlo como
 * motivo de una propiedad).
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
    /**
     * El modo de lo que se programa: uno solo, o el de cada propiedad según su marca (un lote del
     * administrador puede mezclar marcas encendidas y apagadas, ADR-0036).
     */
    dryRun: boolean | ((listingId: string) => Promise<boolean>);
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
  const channels = asked ? [...new Set(platforms)] : [...LISTING_PLATFORMS];
  // Un solo reloj para todo el lote: la hora se revisó contra este `now`, y un lote largo no debe
  // dejar las últimas propiedades fuera por los segundos que tardó en recorrerse.
  const fixed = { ...deps, now: () => now };

  const results: ScheduleListingOutcome[] = [];
  for (const [index, listingId] of listingIds.entries()) {
    const when = new Date(first.getTime() + index * spacingMinutes * 60_000);
    const own: ScheduleListingOutcome[] = [];
    const listingDryRun = typeof dryRun === "boolean" ? dryRun : await dryRun(listingId);
    for (const platform of channels) {
      try {
        const done = await scheduleChannel(fixed, {
          listingId,
          platform,
          at: when,
          dryRun: listingDryRun,
          actor,
          reason: listingIds.length > 1 ? "batch" : "operator",
        });
        own.push({
          listingId,
          platform,
          outcome: "scheduled",
          at: when,
          publications: done.scheduled,
        });
      } catch (error) {
        // Un error pasajero (la base, la red) corta el lote: no es un motivo de esa propiedad.
        if (!isAppError(error) || error.retriable) throw error;
        if (!asked && SILENT_WITHOUT_PLATFORMS.has(error.code)) continue;
        own.push({
          listingId,
          platform,
          outcome: "skipped",
          code: error.code,
          message: error.message,
        });
      }
    }
    results.push(...collapse(listingId, own, asked));
  }
  return { results, notes: marketplaceReminderNotes(results) };
}

/**
 * Lo de una propiedad en el lote. Sin canales pedidos: si no hay nada, una fila "sin canales"; si
 * todos los canales fallaron por lo mismo (la propiedad no está lista, no existe), una sola fila
 * sin canal en vez de una por canal.
 */
function collapse(
  listingId: string,
  own: readonly ScheduleListingOutcome[],
  asked: boolean,
): ScheduleListingOutcome[] {
  if (own.length === 0) {
    return [
      {
        listingId,
        platform: null,
        outcome: "skipped",
        code: "NOTHING_TO_PUBLISH",
        message: "La propiedad no tiene canales con el texto aprobado y la cuenta conectada",
      },
    ];
  }
  const [first] = own;
  if (
    !asked &&
    own.length > 1 &&
    first?.outcome === "skipped" &&
    own.every((item) => item.outcome === "skipped" && item.code === first.code)
  ) {
    return [{ ...first, platform: null }];
  }
  return [...own];
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

/** El resultado de programar un post en una red (F9-T07). */
export type SchedulePostOutcome =
  | { platform: Platform; outcome: "scheduled"; at: Date; publications: Publication[] }
  | { platform: Platform | null; outcome: "skipped"; code: string; message: string };

/**
 * Programa un post (F9-T07, ADR-0029 punto 4; `POST /posts/:id/schedule`, F9-T12): cada red pedida
 * (o, sin `platforms`, cada red con un texto aprobado y la cuenta conectada) a la hora `at`, dentro
 * del candado del post, con las mismas revisiones que publicarlo (`preparePostChannelStart`): abre
 * las que falten de cada idioma y programa las pendientes de cuentas conectadas (las que ya se
 * están publicando no cuentan). El modo es el de la API (`dryRun`). Una red que no se puede
 * programar no corta las demás: queda `skipped` con su código; sin redes pedidas, las que no tienen
 * texto aprobado o cuenta no se informan, y si no queda ninguna, una fila sin red
 * (`NOTHING_TO_PUBLISH`). Programa **red por red, cada una en su propia vuelta del candado** (como
 * `scheduleListings` con cada canal): si el post cambia a medias (lo archivan, se cae la base),
 * el pedido puede fallar con algunas redes ya programadas; lo programado queda y repetir el pedido
 * es idempotente (a la misma hora y modo, no cambia nada). Errores del pedido (cortan sin seguir):
 * los de la hora (`SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR`, `SCHEDULE_AT_INVALID`), los del post
 * (`POST_NOT_FOUND`, `POST_NOT_READY`), `SUBJECT_NOT_LISTING` sin `postLock` y cualquier error
 * reintentable (la base).
 */
export async function schedulePost(
  deps: SubjectLocks & { now?: () => Date },
  {
    postId,
    platforms,
    at,
    dryRun,
    actor,
  }: {
    postId: string;
    platforms?: readonly Platform[];
    at: Date;
    dryRun: boolean;
    actor: PublicationActor;
  },
): Promise<{ results: SchedulePostOutcome[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const when = checkScheduleAt(at, now);
  const subject = postSubject(postId);
  const asked = platforms !== undefined && platforms.length > 0;
  const channels = asked ? [...new Set(platforms)] : [...POST_PLATFORMS];
  const results: SchedulePostOutcome[] = [];
  /** Sin redes pedidas: hubo textos aprobados de redes que se le quitaron al post. */
  let excludedSeen = false;
  for (const platform of channels) {
    try {
      const scheduled = await runOnSubject(deps, subject, async (locked) => {
        // `runOnSubject` con un post siempre da el candado del post.
        if (locked.kind !== "post") throw new AppError("INTERNAL_ERROR", "Candado equivocado");
        return schedulePostChannel(locked.repos, {
          subject,
          platform,
          at: when,
          dryRun,
          actor,
        });
      });
      results.push({ platform, outcome: "scheduled", at: when, publications: scheduled });
    } catch (error) {
      // Un error pasajero (la base) o del post entero corta el pedido: no es un motivo de la red.
      if (!isAppError(error) || error.retriable || POST_REQUEST_ERRORS.has(error.code)) {
        throw error;
      }
      // Sin redes pedidas, solo las del post (`posts.platforms`, F9-T21): una red que el operador
      // le quitó no se programa ni se informa, aunque su texto siga aprobado.
      if (!asked && error.code === "POST_PLATFORM_EXCLUDED") {
        excludedSeen = true;
        continue;
      }
      if (!asked && SILENT_WITHOUT_PLATFORMS.has(error.code)) continue;
      results.push({ platform, outcome: "skipped", code: error.code, message: error.message });
    }
  }
  if (results.length === 0) {
    results.push({
      platform: null,
      outcome: "skipped",
      code: "NOTHING_TO_PUBLISH",
      message: excludedSeen
        ? "El post no tiene redes con el texto aprobado y la cuenta conectada: hay textos aprobados de redes que se quitaron del post (agrégalas al post para programarlos)"
        : "El post no tiene redes con el texto aprobado y la cuenta conectada",
    });
  }
  return { results };
}

/** Errores del post o del pedido (no de una red): cortan `schedulePost` en vez de saltar la red. */
const POST_REQUEST_ERRORS = new Set(["POST_NOT_FOUND", "POST_NOT_READY", "SUBJECT_NOT_LISTING"]);

/** Un canal de un post (una red, todos sus idiomas), dentro de su candado: abre y programa. */
async function schedulePostChannel(
  locked: PostLockedRepositories,
  {
    subject,
    platform,
    at,
    dryRun,
    actor,
  }: {
    subject: PostSubject;
    platform: Platform;
    at: Date;
    dryRun: boolean;
    actor: PublicationActor;
  },
): Promise<Publication[]> {
  const { post, opening, startable } = await preparePostChannelStart(
    locked,
    { subject, platform },
    {
      dryRun,
      countInFlight: false,
      nothingMessage: "No hay nada que programar en esta red: todo está publicado o publicándose",
    },
  );
  // Recién aquí se escribe.
  const created: Publication[] = [];
  for (const { content, planned } of opening.toCreate) {
    created.push(...(await createPostPublications(locked, { post, content, planned, actor })));
  }
  const ids = new Set<string>();
  for (const publication of [...startable, ...created]) {
    ids.add(
      (
        await scheduleOne(locked.publications, publication, {
          at,
          dryRun,
          actor,
          reason: "operator",
        })
      ).id,
    );
  }
  // Releídas: el resultado muestra la hora y el modo guardados.
  return (await channelPublications(locked, subject, platform)).filter((p) => ids.has(p.id));
}

/**
 * Desprograma una publicación (`POST /publications/:id/unschedule`): `scheduled` → `approved`, sin
 * tocar su texto (sigue aprobado), dentro del candado de su sujeto (aviso o post). Otra cosa →
 * `INVALID_TRANSITION`.
 */
export async function unschedulePublication(
  deps: SubjectLocks & { publications: Pick<PublicationRepository, "get"> },
  { publicationId, actor }: { publicationId: string; actor: PublicationActor },
): Promise<Publication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  return runOnSubject(deps, found.subject, async ({ repos: locked }) => {
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
