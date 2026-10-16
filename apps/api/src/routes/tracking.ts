import {
  AppError,
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
import { Hono } from "hono";
import {
  type AgendaResponse,
  agendaQuerySchema,
  type TrackingResponse,
  trackingQuerySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";
import { coverPaths } from "./listings.js";

export type TrackingRoutesDeps = {
  listings: Pick<ListingRepository, "list">;
  brokers: Pick<BrokerRepository, "findBySlug" | "list">;
  publications: Pick<PublicationRepository, "listForTracking">;
  media: Pick<MediaRepository, "listCovers" | "listVariants">;
  storage: Pick<MediaStorage, "signedReadUrl">;
  contents: Pick<ContentRepository, "listCurrent">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  /** El estado del respaldo (`readBackupStatus`); sin él la agenda no lo informa. */
  backupStatus?: () => Promise<BackupStatus | null>;
  now?: () => Date;
};

/** Las propiedades de un corredor (por su slug) o de todos; `BROKER_NOT_FOUND` si no existe. */
async function listingsOf(deps: TrackingRoutesDeps, slug: string | undefined): Promise<Listing[]> {
  const all = await deps.listings.list();
  if (slug === undefined) return all;
  const broker = await deps.brokers.findBySlug(slug);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`, {
      details: { broker: slug },
    });
  }
  return all.filter((listing) => listing.brokerId === broker.id);
}

/**
 * Carga lo que `pendingReviewsOf` (core) necesita: las cuentas y los textos vigentes solo de las
 * propiedades sobre las que actúa `auto_publish` (`autoPublishApplies`). Una consulta de textos
 * por propiedad: con el volumen de hoy alcanza (deuda para T13: una consulta para todas).
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
  const contentsByListing = new Map<string, Content[]>();
  for (const listing of candidates) {
    if (!connectedByBroker.has(listing.brokerId)) {
      connectedByBroker.set(
        listing.brokerId,
        connectedPlatforms(await deps.platformAccounts.listByBroker(listing.brokerId)),
      );
    }
    contentsByListing.set(listing.id, await deps.contents.listCurrent(listing.id));
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
  return new Hono()
    .get("/tracking", validated("query", trackingQuerySchema), async (c) => {
      const { broker, archived } = c.req.valid("query");
      const at = now();
      const listings = (await listingsOf(deps, broker)).filter(
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
      const listings = (await listingsOf(deps, broker)).filter(
        (listing) => listing.status !== "archived",
      );
      const brokers = new Map((await deps.brokers.list()).map((b) => [b.id, b]));
      const autoPublishBrokerIds = new Set(
        [...brokers.values()].filter((b) => b.autoPublish).map((b) => b.id),
      );
      const backup =
        deps.backupStatus === undefined ? undefined : await deps.backupStatus().catch(() => null);
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
