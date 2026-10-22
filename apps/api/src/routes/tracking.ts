import {
  type AccessScope,
  agendaItems,
  autoPublishApplies,
  type BackupStatus,
  type Broker,
  type BrokerRepository,
  type Content,
  type ContentRepository,
  calendarEntries,
  connectedPlatforms,
  type Listing,
  type ListingRepository,
  listingIdOf,
  type MediaRepository,
  type MediaStorage,
  type PendingReview,
  type Platform,
  type PlatformAccountRepository,
  type Post,
  type PostRepository,
  type PostStatus,
  type PublicationRepository,
  pendingReviewsOf,
  TRACKING_WINDOW_MS,
  trackingPostRow,
  trackingRow,
  type WorkerHeartbeat,
  type WorkerStatus,
  workerStatusOf,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth.js";
import {
  type AgendaResponse,
  agendaQuerySchema,
  type CalendarResponse,
  calendarQuerySchema,
  type TrackingResponse,
  trackingQuerySchema,
} from "../contracts/index.js";
import { listScope, requestScope } from "../scope.js";
import { validated } from "../validation.js";
import { coverPaths } from "./listings.js";

export type TrackingRoutesDeps = {
  listings: Pick<ListingRepository, "list">;
  /** Los posts del alcance (F9-T08): van a la agenda y al seguimiento junto a los avisos. */
  posts: Pick<PostRepository, "list">;
  brokers: Pick<BrokerRepository, "findBySlug" | "list">;
  publications: Pick<PublicationRepository, "listForTracking">;
  media: Pick<MediaRepository, "listCovers" | "listVariants">;
  storage: Pick<MediaStorage, "signedReadUrl">;
  contents: Pick<ContentRepository, "listCurrentMany">;
  /** `list`: las cuentas del alcance, para el token por vencer (F9-T08). */
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker" | "list">;
  /** El estado del respaldo (`readBackupStatus`); sin él la agenda no lo informa. */
  backupStatus?: () => Promise<BackupStatus | null>;
  /**
   * Los latidos más recientes del worker (los de `/health`, F8-T12): con ellos la agenda del
   * administrador avisa si el worker está apagado y hay algo por vencer (F9.5-T24).
   */
  workerHeartbeats?: () => Promise<WorkerHeartbeat[]>;
  now?: () => Date;
};

/**
 * El alcance del pedido (spec F7 §4.4): el de un corredor (`?broker`, el administrador) o todo lo
 * que la sesión ve; `BROKER_NOT_FOUND` si el corredor no existe o es ajeno. Las propiedades, los
 * posts y las cuentas se filtran con él en SQL.
 */
const scopeOf = (c: Context<AppEnv>, deps: TrackingRoutesDeps, slug: string | undefined) =>
  listScope(c, deps.brokers, slug);

/** Los posts con publicaciones posibles: sin las ideas (no tienen textos) ni, salvo pedido, los archivados. */
const trackedPostStatuses = (archived: boolean): PostStatus[] =>
  archived ? ["draft", "ready", "archived"] : ["draft", "ready"];

const postsOf = (deps: TrackingRoutesDeps, scope: AccessScope, archived: boolean) =>
  deps.posts.list({ status: trackedPostStatuses(archived) }, scope);

/**
 * Carga lo que `pendingReviewsOf` (core) necesita: las cuentas y los textos vigentes solo de las
 * propiedades sobre las que actúa `auto_publish` (`autoPublishApplies`), con una sola consulta de
 * textos para todas (`listCurrentMany`, deuda de F6).
 */
async function pendingReviews(
  deps: TrackingRoutesDeps,
  listings: readonly Listing[],
  brokers: ReadonlyMap<string, Broker>,
): Promise<PendingReview[]> {
  const candidates = listings.filter((listing) =>
    autoPublishApplies(listing, brokers.get(listing.brokerId) ?? null),
  );
  const connectedByBroker = new Map<string, ReadonlySet<Platform>>();
  for (const listing of candidates) {
    if (!connectedByBroker.has(listing.brokerId)) {
      connectedByBroker.set(
        listing.brokerId,
        connectedPlatforms(await deps.platformAccounts.listByBroker(listing.brokerId)),
      );
    }
  }
  const contentsByListing = new Map<string, Content[]>();
  const current =
    candidates.length === 0
      ? []
      : await deps.contents.listCurrentMany(candidates.map((listing) => listing.id));
  for (const content of current) {
    // `listCurrentMany` es de avisos: cada texto tiene su aviso.
    const listingId = listingIdOf(content.subject);
    contentsByListing.set(listingId, [...(contentsByListing.get(listingId) ?? []), content]);
  }
  return pendingReviewsOf({ listings: candidates, brokers, connectedByBroker, contentsByListing });
}

/**
 * `GET /tracking` y `GET /agenda` (spec F6 §4.9): la matriz por propiedad y plataforma y la
 * agenda, armadas por `trackingRow`, `trackingPostRow` y `agendaItems` (core, puras) con las
 * propiedades y, desde F9-T08, los posts del alcance y sus publicaciones de `listForTracking`. La
 * agenda suma las cuentas del alcance (el token por vencer). `GET /calendar` (F9-T18): lo
 * programado y lo publicado en un rango, de avisos y posts (`calendarEntries`, core). Solo leen.
 */
export function trackingRoutes(deps: TrackingRoutesDeps) {
  const now = () => (deps.now ?? (() => new Date()))();
  const publicationsOf = (listings: readonly Listing[], posts: readonly Post[], at: Date) =>
    listings.length === 0 && posts.length === 0
      ? Promise.resolve([])
      : deps.publications.listForTracking({
          listingIds: listings.map((listing) => listing.id),
          postIds: posts.map((post) => post.id),
          since: new Date(at.getTime() - TRACKING_WINDOW_MS),
        });
  return new Hono<AppEnv>()
    .get("/tracking", validated("query", trackingQuerySchema), async (c) => {
      const { broker, archived } = c.req.valid("query");
      const at = now();
      const scope = await scopeOf(c, deps, broker);
      const listings = (await deps.listings.list({}, scope)).filter(
        (listing) => archived === "1" || listing.status !== "archived",
      );
      const posts = await postsOf(deps, scope, archived === "1");
      const publications = await publicationsOf(listings, posts, at);
      const covers = await coverPaths(
        deps.media,
        listings.map((listing) => listing.id),
      );
      const body: TrackingResponse = {
        rows: await Promise.all(
          listings.map(async (listing) => {
            const path = covers.get(listing.id);
            return {
              ...trackingRow(listing, publications, at),
              coverUrl: path === undefined ? null : await deps.storage.signedReadUrl(path),
            };
          }),
        ),
        posts: posts.map((post) => trackingPostRow(post, publications, at)),
      };
      return c.json(body, 200);
    })
    .get("/agenda", validated("query", agendaQuerySchema), async (c) => {
      const { broker } = c.req.valid("query");
      const at = now();
      const listScopeOf = await scopeOf(c, deps, broker);
      const listings = (await deps.listings.list({}, listScopeOf)).filter(
        (listing) => listing.status !== "archived",
      );
      const posts = await postsOf(deps, listScopeOf, false);
      const scope = requestScope(c);
      const brokers = new Map((await deps.brokers.list(scope)).map((b) => [b.id, b]));
      const accounts = (await deps.platformAccounts.list(listScopeOf)).map((account) => ({
        ...account,
        brokerSlug: brokers.get(account.brokerId)?.slug ?? null,
      }));
      const autoPublishBrokerIds = new Set(
        [...brokers.values()].filter((b) => b.autoPublish).map((b) => b.id),
      );
      // El respaldo es del administrador (spec F7 §4.4): el corredor no lo ve en su agenda.
      const backup =
        deps.backupStatus === undefined || scope.kind !== "all"
          ? undefined
          : await deps.backupStatus().catch(() => null);
      // El worker también (F9.5-T24): encenderlo es del administrador; si no se pudo leer, sin aviso.
      const worker: WorkerStatus | null | undefined =
        deps.workerHeartbeats === undefined || scope.kind !== "all"
          ? undefined
          : await deps
              .workerHeartbeats()
              .then((processes) => workerStatusOf(processes, at))
              .catch(() => null);
      const body: AgendaResponse = {
        items: agendaItems({
          listings,
          posts,
          publications: await publicationsOf(listings, posts, at),
          accounts,
          autoPublishBrokerIds,
          pendingReviews: await pendingReviews(deps, listings, brokers),
          ...(backup === undefined ? {} : { backup }),
          ...(worker === undefined ? {} : { worker }),
          now: at,
        }),
      };
      return c.json(body, 200);
    })
    .get("/calendar", validated("query", calendarQuerySchema), async (c) => {
      const query = c.req.valid("query");
      const from = new Date(query.from);
      const to = new Date(query.to);
      const scope = await scopeOf(c, deps, query.broker);
      // Todos los avisos y posts del alcance (también archivados: lo que ya salió sigue en su día);
      // las ideas no tienen publicaciones. `listForTracking` desde `from` trae las activas (las
      // programadas) y las que cambiaron desde entonces (las publicadas en el rango).
      const listings = await deps.listings.list({}, scope);
      const posts = await postsOf(deps, scope, true);
      const publications =
        listings.length === 0 && posts.length === 0
          ? []
          : await deps.publications.listForTracking({
              listingIds: listings.map((listing) => listing.id),
              postIds: posts.map((post) => post.id),
              since: from,
            });
      const slugs = new Map(
        (await deps.brokers.list(requestScope(c))).map((broker) => [broker.id, broker.slug]),
      );
      const body: CalendarResponse = {
        entries: calendarEntries({ listings, posts, publications, from, to, now: now() }).map(
          (entry) => ({ ...entry, brokerSlug: slugs.get(entry.brokerId) ?? null }),
        ),
      };
      return c.json(body, 200);
    });
}
