import {
  agendaItems,
  autoPublishApplies,
  type BackupStatus,
  type Broker,
  type BrokerRepository,
  type Content,
  type ContentRepository,
  connectedPlatforms,
  type Listing,
  type ListingRepository,
  listingIdOf,
  type MediaRepository,
  type MediaStorage,
  type PendingReview,
  type Platform,
  type PlatformAccountRepository,
  type PublicationRepository,
  pendingReviewsOf,
  TRACKING_WINDOW_MS,
  trackingRow,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth.js";
import {
  type AgendaResponse,
  agendaQuerySchema,
  type TrackingResponse,
  trackingQuerySchema,
} from "../contracts/index.js";
import { listScope, requestScope } from "../scope.js";
import { validated } from "../validation.js";
import { coverPaths } from "./listings.js";

export type TrackingRoutesDeps = {
  listings: Pick<ListingRepository, "list">;
  brokers: Pick<BrokerRepository, "findBySlug" | "list">;
  publications: Pick<PublicationRepository, "listForTracking">;
  media: Pick<MediaRepository, "listCovers" | "listVariants">;
  storage: Pick<MediaStorage, "signedReadUrl">;
  contents: Pick<ContentRepository, "listCurrentMany">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  /** El estado del respaldo (`readBackupStatus`); sin él la agenda no lo informa. */
  backupStatus?: () => Promise<BackupStatus | null>;
  now?: () => Date;
};

/**
 * Las propiedades del alcance (spec F7 §4.4), filtradas en SQL: las de un corredor (`?broker`, el
 * administrador) o todas las que la sesión ve; `BROKER_NOT_FOUND` si el corredor no existe o es
 * ajeno.
 */
async function listingsOf(
  c: Context<AppEnv>,
  deps: TrackingRoutesDeps,
  slug: string | undefined,
): Promise<Listing[]> {
  return deps.listings.list({}, await listScope(c, deps.brokers, slug));
}

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
 * agenda, armadas por `trackingRow` y `agendaItems` (core, puras) con las propiedades del corredor
 * y sus publicaciones de `listForTracking`. Solo leen.
 */
export function trackingRoutes(deps: TrackingRoutesDeps) {
  const now = () => (deps.now ?? (() => new Date()))();
  const publicationsOf = (listings: readonly Listing[], at: Date) =>
    listings.length === 0
      ? Promise.resolve([])
      : deps.publications.listForTracking({
          listingIds: listings.map((listing) => listing.id),
          since: new Date(at.getTime() - TRACKING_WINDOW_MS),
        });
  return new Hono<AppEnv>()
    .get("/tracking", validated("query", trackingQuerySchema), async (c) => {
      const { broker, archived } = c.req.valid("query");
      const at = now();
      const listings = (await listingsOf(c, deps, broker)).filter(
        (listing) => archived === "1" || listing.status !== "archived",
      );
      const publications = await publicationsOf(listings, at);
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
      };
      return c.json(body, 200);
    })
    .get("/agenda", validated("query", agendaQuerySchema), async (c) => {
      const { broker } = c.req.valid("query");
      const at = now();
      const listings = (await listingsOf(c, deps, broker)).filter(
        (listing) => listing.status !== "archived",
      );
      const scope = requestScope(c);
      const brokers = new Map((await deps.brokers.list(scope)).map((b) => [b.id, b]));
      const autoPublishBrokerIds = new Set(
        [...brokers.values()].filter((b) => b.autoPublish).map((b) => b.id),
      );
      // El respaldo es del administrador (spec F7 §4.4): el corredor no lo ve en su agenda.
      const backup =
        deps.backupStatus === undefined || scope.kind !== "all"
          ? undefined
          : await deps.backupStatus().catch(() => null);
      const body: AgendaResponse = {
        items: agendaItems({
          listings,
          publications: await publicationsOf(listings, at),
          autoPublishBrokerIds,
          pendingReviews: await pendingReviews(deps, listings, brokers),
          ...(backup === undefined ? {} : { backup }),
          now: at,
        }),
      };
      return c.json(body, 200);
    });
}
