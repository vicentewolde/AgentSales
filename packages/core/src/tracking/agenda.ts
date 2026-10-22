import type { Broker } from "../broker.js";
import type { Content } from "../content.js";
import type { Platform, PublicationFormat } from "../enums.js";
import type { BackupStatus } from "../health.js";
import { isBackupStale } from "../health.js";
import type { Listing } from "../listing.js";
import type { PlatformAccount } from "../platform-account.js";
import { portalExpiry } from "../portal/expiry.js";
import type { Post } from "../post.js";
import { hasStartedLive, type Publication, publicationModeFixed } from "../publication.js";
import { publicationErrorAdvice } from "../publish/error-advice.js";
import { manualHandoffProgressSchema } from "../publish/outcome.js";
import { scheduleState } from "../schedule.js";
import { autoPublishApplies, autoPublishContents } from "../use-cases/auto-publish-listing.js";
import { canRelist, relistedIds } from "../use-cases/relist-publication.js";
import { STALE_PUBLISHING_MS } from "../use-cases/watch-publications.js";
import { isManualTask } from "./manual-tasks.js";
import { accountTokenExpiry } from "./token-expiry.js";

// La agenda (spec F6 §4.9; desde F9-T08, spec F9 §4.2, con posts y avisos juntos): lo que el
// operador tiene que mirar, en orden.

/**
 * Las clases de ítem, en el orden en que se muestran:
 * - `overdue`: programada que no salió (más de 12 h de atraso);
 * - `your_turn`: recordatorio de Marketplace con la hora vencida ("te toca");
 * - `outcome_unknown`: el intento se cortó después de enviar y no se sabe si salió (F9, ADR-0029
 *   punto 8); el operador la resuelve ("salió" o "no salió");
 * - `stuck`: `publishing` sin cambios desde hace más de 70 min;
 * - `failed`: falló, con el consejo;
 * - `manual_task`: Instagram o Marketplace en vivo de una propiedad cerrada (`retire`) o, desde F9,
 *   una publicación de una cuenta a mano fuera de Marketplace (LinkedIn) lista para publicar a mano,
 *   en `awaiting_manual_confirm` con su `progress.manual` (`confirm`);
 * - `needs_review`: con `auto_publish`, el texto vigente de un canal conectado que no está
 *   aprobado (su revisión tenía errores, o el operador lo editó después) y espera al operador;
 * - `approved_waiting`: con `auto_publish`, aprobada pero sin publicar (por ejemplo, a Portal le
 *   falta algo);
 * - `token_expiring`: el token de una cuenta que no se renueva sola (LinkedIn) vence en 7 días o
 *   menos, o ya venció (spec F9 §4.7): hay que reconectarla;
 * - `expiring`: Portal que vence en 7 días o menos, o que venció y no se republicó (con la
 *   propiedad lista o activa; si todavía figura publicada, primero un sync);
 * - `upcoming`: programada en los próximos 7 días;
 * - `backup`: el último respaldo de la base (siempre al final, uno solo).
 *
 * Las publicaciones de posts entran en las mismas clases que las de avisos, salvo lo que depende de
 * la propiedad (tareas a mano de una cerrada, `auto_publish`, Portal).
 */
export const AGENDA_KINDS = [
  "overdue",
  "your_turn",
  "outcome_unknown",
  "stuck",
  "failed",
  "manual_task",
  "needs_review",
  "approved_waiting",
  "token_expiring",
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
  /** `outcome_unknown`: decir si salió o no (`publications resolve`, F9-T12). */
  "resolve",
  /** Una publicación a mano lista: publicarla en la red y confirmar con el enlace. */
  "confirm",
  /** `token_expiring`: volver a conectar la cuenta. */
  "reconnect",
  "backup",
  "none",
] as const;
export type AgendaAction = (typeof AGENDA_ACTIONS)[number];

export type AgendaItem = {
  kind: AgendaKind;
  action: AgendaAction;
  /** El aviso de la publicación (o del texto que espera revisión); `null` si es de un post. */
  listingId: string | null;
  /** El post de la publicación (F9); `null` si es de un aviso o no es una publicación. */
  postId: string | null;
  externalRef: string | null;
  /**
   * Lo que se muestra como título: el `id_propiedad` de un aviso, el tema de un post o el nombre de
   * la cuenta (`token_expiring`); `null` en el respaldo.
   */
  title: string | null;
  /** La cuenta de `token_expiring`; `null` en lo demás. */
  accountId: string | null;
  /** El corredor de esa cuenta (para el comando de reconectar); `null` en lo demás. */
  brokerSlug: string | null;
  platform: Platform | null;
  format: PublicationFormat | null;
  publicationId: string | null;
  /** La hora que importa: la programada, la del último cambio, la del vencimiento o del respaldo. */
  at: Date | null;
  /** Si es en simulación (`null` si no es una publicación). */
  dryRun: boolean | null;
  /**
   * Si ese modo ya está fijado (`publicationModeFixed`, D4 del spec F9.5); si no, vale el del
   * servidor. `true` si no es una publicación.
   */
  modeFixed: boolean;
  /** Los medios fijos de la publicación (`null` si no es una publicación). */
  mediaCount: number | null;
  /** El código del error (o de la última falla del respaldo). */
  code: string | null;
  /** Qué hacer con el error (`publicationErrorAdvice`); `null` si no es una falla. */
  advice: string | null;
  /** Portal o el token: los días que le quedan (0 vence hoy); `null` si no aplica. */
  daysLeft: number | null;
  /** Portal o el token: ya venció. */
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

/** Una cuenta para `token_expiring`, con el `slug` de su corredor. */
export type AgendaAccount = Pick<
  PlatformAccount,
  "id" | "brokerId" | "platform" | "displayName" | "status" | "tokenExpiresAt" | "meta"
> & { brokerSlug?: string | null };

export type AgendaInput = {
  listings: readonly Pick<Listing, "id" | "brokerId" | "externalRef" | "status">[];
  /** Los posts del alcance (F9), sin los archivados. */
  posts?: readonly Pick<Post, "id" | "brokerId" | "topic">[];
  /** Las publicaciones de esas propiedades y posts (`listForTracking`). */
  publications: readonly Publication[];
  /** Las cuentas del alcance (para `token_expiring`). */
  accounts?: readonly AgendaAccount[];
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

/** Lo de un ítem que no es de una publicación, vacío. */
const NOT_A_PUBLICATION = {
  listingId: null,
  postId: null,
  externalRef: null,
  accountId: null,
  brokerSlug: null,
  format: null,
  publicationId: null,
  dryRun: null,
  modeFixed: true,
  mediaCount: null,
  code: null,
  advice: null,
  daysLeft: null,
  expired: false,
  stale: false,
} as const;

/**
 * La agenda (`agendaItems`, pura), en el orden de `AGENDA_KINDS` y por hora dentro de cada clase;
 * con la misma hora, por título. Posts y avisos van juntos.
 */
export function agendaItems(input: AgendaInput): AgendaItem[] {
  const { now } = input;
  const listings = new Map(input.listings.map((listing) => [listing.id, listing]));
  const posts = new Map((input.posts ?? []).map((post) => [post.id, post]));
  const relisted = relistedIds(input.publications);
  const items: AgendaItem[] = [];
  for (const publication of input.publications) {
    const owner = ownerOf(publication, listings, posts);
    if (owner === null) continue;
    const kindOf = kindForPublication(publication, owner, input, relisted);
    if (kindOf === null) continue;
    items.push({
      kind: kindOf.kind,
      action: kindOf.action,
      listingId: owner.listingId,
      postId: owner.postId,
      externalRef: owner.externalRef,
      title: owner.title,
      accountId: null,
      brokerSlug: null,
      platform: publication.platform,
      format: publication.format,
      publicationId: publication.id,
      at: kindOf.at,
      dryRun: publication.dryRun,
      modeFixed: publicationModeFixed({
        status: publication.status,
        attempts: publication.attempts,
        startedLive: hasStartedLive(publication),
      }),
      mediaCount: publication.mediaIds.length,
      code: kindOf.extra?.code ?? null,
      advice: kindOf.extra?.advice ?? null,
      daysLeft: kindOf.extra?.daysLeft ?? null,
      expired: kindOf.extra?.expired ?? false,
      stale: false,
    });
  }
  for (const review of input.pendingReviews) {
    const listing = listings.get(review.listingId);
    if (listing === undefined) continue;
    items.push({
      ...NOT_A_PUBLICATION,
      kind: "needs_review",
      action: "review",
      listingId: listing.id,
      externalRef: listing.externalRef,
      title: listing.externalRef,
      platform: review.platform,
      at: null,
    });
  }
  for (const account of input.accounts ?? []) {
    const expiry = accountTokenExpiry(account, now);
    if (expiry === null || !(expiry.soon || expiry.expired)) continue;
    items.push({
      ...NOT_A_PUBLICATION,
      kind: "token_expiring",
      action: "reconnect",
      title: account.displayName,
      accountId: account.id,
      brokerSlug: account.brokerSlug ?? null,
      platform: account.platform,
      at: expiry.expiresAt,
      daysLeft: expiry.daysLeft,
      expired: expiry.expired,
    });
  }
  if (input.backup !== undefined) {
    const stale = isBackupStale(input.backup, now);
    items.push({
      ...NOT_A_PUBLICATION,
      kind: "backup",
      action: stale || input.backup?.lastFailureCode != null ? "backup" : "none",
      title: null,
      platform: null,
      at: input.backup?.lastSuccessAt == null ? null : new Date(input.backup.lastSuccessAt),
      code: input.backup?.lastFailureCode ?? null,
      stale,
    });
  }
  return items.sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) ||
      (a.title ?? "").localeCompare(b.title ?? ""),
  );
}

/**
 * De quién es una publicación en la agenda: su aviso o su post, si está entre los del alcance
 * (`null` si no). `listingStatus` es `null` en un post: lo que depende de la propiedad (tareas a
 * mano de una cerrada, `auto_publish`, Portal) no le aplica.
 */
type AgendaOwner = {
  listingId: string | null;
  postId: string | null;
  brokerId: string;
  externalRef: string | null;
  title: string;
  listingStatus: Listing["status"] | null;
};

function ownerOf(
  publication: Publication,
  listings: ReadonlyMap<string, Pick<Listing, "id" | "brokerId" | "externalRef" | "status">>,
  posts: ReadonlyMap<string, Pick<Post, "id" | "brokerId" | "topic">>,
): AgendaOwner | null {
  const { subject } = publication;
  if (subject.kind === "post") {
    const post = posts.get(subject.id);
    return post === undefined
      ? null
      : {
          listingId: null,
          postId: post.id,
          brokerId: post.brokerId,
          externalRef: null,
          title: post.topic,
          listingStatus: null,
        };
  }
  const listing = listings.get(subject.id);
  return listing === undefined
    ? null
    : {
        listingId: listing.id,
        postId: null,
        brokerId: listing.brokerId,
        externalRef: listing.externalRef,
        title: listing.externalRef,
        listingStatus: listing.status,
      };
}

/** Cuándo quedó lista una publicación a mano (`progress.manual.readyAt`), o su último cambio. */
function manualReadyAt(publication: Publication): Date {
  const parsed = manualHandoffProgressSchema.safeParse(publication.progress);
  return parsed.success ? new Date(parsed.data.manual.readyAt) : publication.updatedAt;
}

function kindForPublication(
  publication: Publication,
  owner: AgendaOwner,
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
    case "failed":
    case "outcome_unknown": {
      const code = publication.lastError?.code ?? null;
      return {
        kind: publication.status,
        action: publication.status === "failed" ? "retry" : "resolve",
        at: publication.updatedAt,
        extra: { code, advice: code === null ? null : publicationErrorAdvice(code) },
      };
    }
    case "awaiting_manual_confirm":
      // La de Marketplace la sigue su propio flujo (el formulario y su ventana, F5); fuera de
      // Marketplace es una cuenta a mano (LinkedIn): el texto y los medios esperan al operador.
      return publication.platform === "fb_marketplace"
        ? null
        : { kind: "manual_task", action: "confirm", at: manualReadyAt(publication) };
    case "approved":
      return owner.listingStatus !== null &&
        input.autoPublishBrokerIds.has(owner.brokerId) &&
        (owner.listingStatus === "ready" || owner.listingStatus === "active")
        ? { kind: "approved_waiting", action: "publish", at: publication.updatedAt }
        : null;
    case "published":
    case "paused":
    case "unpublished": {
      const listingStatus = owner.listingStatus;
      // Lo de abajo depende de la propiedad (cerrada, Portal): un post no lo tiene.
      if (listingStatus === null) return null;
      if (isManualTask(listingStatus, publication)) {
        return { kind: "manual_task", action: "retire", at: publication.publishedAt };
      }
      if (publication.platform !== "portal_inmobiliario" || publication.dryRun) return null;
      const expiry = portalExpiry(publication.remoteState, now);
      if (expiry === null) return null;
      if (publication.status === "unpublished") {
        // La misma regla del panel (`canRelist`): sin republicación viva y la propiedad lista o activa.
        return expiry.expired && canRelist(publication, listingStatus, relisted)
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
