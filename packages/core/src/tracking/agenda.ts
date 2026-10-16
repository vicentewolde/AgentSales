import type { Broker } from "../broker.js";
import type { Content } from "../content.js";
import type { Platform, PublicationFormat } from "../enums.js";
import type { BackupStatus } from "../health.js";
import { isBackupStale } from "../health.js";
import type { Listing } from "../listing.js";
import { portalExpiry } from "../portal/expiry.js";
import type { Publication } from "../publication.js";
import { publicationErrorAdvice } from "../publish/error-advice.js";
import { scheduleState } from "../schedule.js";
import { autoPublishApplies, autoPublishContents } from "../use-cases/auto-publish-listing.js";
import { canRelist, relistedIds } from "../use-cases/relist-publication.js";
import { STALE_PUBLISHING_MS } from "../use-cases/watch-publications.js";
import { isManualTask } from "./manual-tasks.js";

// La agenda (spec F6 §4.9): lo que el operador tiene que mirar, en orden.

/**
 * Las clases de ítem, en el orden en que se muestran:
 * - `overdue`: programada que no salió (más de 12 h de atraso);
 * - `your_turn`: recordatorio de Marketplace con la hora vencida ("te toca");
 * - `stuck`: `publishing` sin cambios desde hace más de 70 min;
 * - `failed`: falló, con el consejo;
 * - `manual_task`: Instagram o Marketplace en vivo de una propiedad cerrada;
 * - `needs_review`: con `auto_publish`, el texto vigente de un canal conectado que no está
 *   aprobado (su revisión tenía errores, o el operador lo editó después) y espera al operador;
 * - `approved_waiting`: con `auto_publish`, aprobada pero sin publicar (por ejemplo, a Portal le
 *   falta algo);
 * - `expiring`: Portal que vence en 7 días o menos, o que venció y no se republicó (con la
 *   propiedad lista o activa; si todavía figura publicada, primero un sync);
 * - `upcoming`: programada en los próximos 7 días;
 * - `backup`: el último respaldo de la base (siempre al final, uno solo).
 */
export const AGENDA_KINDS = [
  "overdue",
  "your_turn",
  "stuck",
  "failed",
  "manual_task",
  "needs_review",
  "approved_waiting",
  "expiring",
  "upcoming",
  "backup",
] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];

/** Qué conviene hacer: la CLI lo traduce a un comando y el panel a un texto con qué hacer. */
export const AGENDA_ACTIONS = [
  "publish",
  "reschedule",
  "requeue",
  "retry",
  "retire",
  "review",
  "relist",
  "sync",
  "backup",
  "none",
] as const;
export type AgendaAction = (typeof AGENDA_ACTIONS)[number];

export type AgendaItem = {
  kind: AgendaKind;
  action: AgendaAction;
  listingId: string | null;
  externalRef: string | null;
  platform: Platform | null;
  format: PublicationFormat | null;
  publicationId: string | null;
  /** La hora que importa: la programada, la del último cambio, la del vencimiento o del respaldo. */
  at: Date | null;
  /** Si es en simulación (`null` si no es una publicación). */
  dryRun: boolean | null;
  /** El código del error (o de la última falla del respaldo). */
  code: string | null;
  /** Qué hacer con el error (`publicationErrorAdvice`); `null` si no es una falla. */
  advice: string | null;
  /** Portal: los días que le quedan al aviso (0 vence hoy); `null` si no aplica. */
  daysLeft: number | null;
  /** Portal: ya venció. */
  expired: boolean;
  /** El respaldo tiene más de 48 h, o no hay ninguno. */
  stale: boolean;
};

/**
 * La matriz y la agenda miran las publicaciones activas y las terminadas de los últimos 30 días
 * (`listForTracking`, spec F6 §4.9).
 */
export const TRACKING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Lo que espera la revisión del operador con `auto_publish` (spec F6 §4.10): en cada propiedad sobre
 * la que actúa (`autoPublishApplies`), el texto vigente de cada canal conectado
 * (`autoPublishContents`, la misma regla de `autoPublishListing`) que no está aprobado.
 */
export function pendingReviewsOf(input: {
  listings: readonly Pick<Listing, "id" | "brokerId" | "status">[];
  brokers: ReadonlyMap<string, Pick<Broker, "autoPublish">>;
  connectedByBroker: ReadonlyMap<string, ReadonlySet<Platform>>;
  contentsByListing: ReadonlyMap<string, readonly Pick<Content, "platform" | "status">[]>;
}): PendingReview[] {
  return input.listings.flatMap((listing) => {
    if (!autoPublishApplies(listing, input.brokers.get(listing.brokerId) ?? null)) return [];
    const connected = input.connectedByBroker.get(listing.brokerId) ?? new Set<Platform>();
    return autoPublishContents(input.contentsByListing.get(listing.id) ?? [], connected)
      .filter((content) => content.status !== "approved")
      .map((content) => ({ listingId: listing.id, platform: content.platform }));
  });
}

/** Un texto de un canal que espera la revisión del operador (lo arma la API). */
export type PendingReview = { listingId: string; platform: Platform };

export type AgendaInput = {
  listings: readonly Pick<Listing, "id" | "brokerId" | "externalRef" | "status">[];
  /** Las publicaciones de esas propiedades (`listForTracking`). */
  publications: readonly Publication[];
  /** Los corredores con `auto_publish` (para `approved_waiting`). */
  autoPublishBrokerIds: ReadonlySet<string>;
  pendingReviews: readonly PendingReview[];
  /** `undefined`: no se informa el respaldo; `null`: nunca se respaldó. */
  backup?: BackupStatus | null;
  now: Date;
};

/** Hasta dónde mira `upcoming`. */
export const AGENDA_UPCOMING_MS = 7 * 24 * 60 * 60 * 1000;

const rank = (kind: AgendaKind) => AGENDA_KINDS.indexOf(kind);

/** La agenda (`agendaItems`, pura), en el orden de `AGENDA_KINDS` y por hora dentro de cada clase. */
export function agendaItems(input: AgendaInput): AgendaItem[] {
  const { now } = input;
  const listings = new Map(input.listings.map((listing) => [listing.id, listing]));
  const relisted = relistedIds(input.publications);
  const items: AgendaItem[] = [];
  for (const publication of input.publications) {
    const listing = listings.get(publication.listingId);
    if (listing === undefined) continue;
    const item = (
      kind: AgendaKind,
      action: AgendaAction,
      at: Date | null,
      extra: Partial<Pick<AgendaItem, "code" | "advice" | "daysLeft" | "expired">> = {},
    ): AgendaItem => ({
      kind,
      action,
      listingId: listing.id,
      externalRef: listing.externalRef,
      platform: publication.platform,
      format: publication.format,
      publicationId: publication.id,
      at,
      dryRun: publication.dryRun,
      code: extra.code ?? null,
      advice: extra.advice ?? null,
      daysLeft: extra.daysLeft ?? null,
      expired: extra.expired ?? false,
      stale: false,
    });
    const kindOf = kindForPublication(publication, listing, input, relisted);
    if (kindOf === null) continue;
    items.push(item(kindOf.kind, kindOf.action, kindOf.at, kindOf.extra));
  }
  for (const review of input.pendingReviews) {
    const listing = listings.get(review.listingId);
    if (listing === undefined) continue;
    items.push({
      kind: "needs_review",
      action: "review",
      listingId: listing.id,
      externalRef: listing.externalRef,
      platform: review.platform,
      format: null,
      publicationId: null,
      at: null,
      dryRun: null,
      code: null,
      advice: null,
      daysLeft: null,
      expired: false,
      stale: false,
    });
  }
  if (input.backup !== undefined) {
    const stale = isBackupStale(input.backup, now);
    items.push({
      kind: "backup",
      action: stale || input.backup?.lastFailureCode != null ? "backup" : "none",
      listingId: null,
      externalRef: null,
      platform: null,
      format: null,
      publicationId: null,
      at: input.backup?.lastSuccessAt == null ? null : new Date(input.backup.lastSuccessAt),
      dryRun: null,
      code: input.backup?.lastFailureCode ?? null,
      advice: null,
      daysLeft: null,
      expired: false,
      stale,
    });
  }
  return items.sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) ||
      (a.externalRef ?? "").localeCompare(b.externalRef ?? ""),
  );
}

function kindForPublication(
  publication: Publication,
  listing: Pick<Listing, "brokerId" | "status">,
  input: AgendaInput,
  relisted: ReadonlySet<string>,
): {
  kind: AgendaKind;
  action: AgendaAction;
  at: Date | null;
  extra?: Partial<Pick<AgendaItem, "code" | "advice" | "daysLeft" | "expired">>;
} | null {
  const { now } = input;
  switch (publication.status) {
    case "scheduled": {
      const state = scheduleState(publication, now);
      if (state === "overdue")
        return { kind: "overdue", action: "publish", at: publication.scheduledAt };
      if (state === "due" && publication.platform === "fb_marketplace") {
        return { kind: "your_turn", action: "publish", at: publication.scheduledAt };
      }
      if (
        state === "upcoming" &&
        publication.scheduledAt !== null &&
        publication.scheduledAt.getTime() - now.getTime() <= AGENDA_UPCOMING_MS
      ) {
        return { kind: "upcoming", action: "none", at: publication.scheduledAt };
      }
      return null;
    }
    case "publishing":
      return now.getTime() - publication.updatedAt.getTime() > STALE_PUBLISHING_MS
        ? { kind: "stuck", action: "requeue", at: publication.updatedAt }
        : null;
    case "failed": {
      const code = publication.lastError?.code ?? null;
      return {
        kind: "failed",
        action: "retry",
        at: publication.updatedAt,
        extra: { code, advice: code === null ? null : publicationErrorAdvice(code) },
      };
    }
    case "approved":
      return input.autoPublishBrokerIds.has(listing.brokerId) &&
        (listing.status === "ready" || listing.status === "active")
        ? { kind: "approved_waiting", action: "publish", at: publication.updatedAt }
        : null;
    case "published":
    case "paused":
    case "unpublished": {
      if (isManualTask(listing.status, publication)) {
        return { kind: "manual_task", action: "retire", at: publication.publishedAt };
      }
      if (publication.platform !== "portal_inmobiliario" || publication.dryRun) return null;
      const expiry = portalExpiry(publication.remoteState, now);
      if (expiry === null) return null;
      if (publication.status === "unpublished") {
        // La misma regla del panel (`canRelist`): sin republicación viva y la propiedad lista o activa.
        return expiry.expired && canRelist(publication, listing.status, relisted)
          ? {
              kind: "expiring",
              action: "relist",
              at: expiry.stopTime,
              extra: { expired: true, daysLeft: expiry.daysLeft },
            }
          : null;
      }
      return expiry.soon || expiry.expired
        ? {
            kind: "expiring",
            // Venció pero todavía figura publicada: un sync la deja cerrada y entonces se republica.
            action: expiry.expired ? "sync" : "none",
            at: expiry.stopTime,
            extra: { expired: expiry.expired, daysLeft: expiry.daysLeft },
          }
        : null;
    }
    default:
      return null;
  }
}
