import {
  AppError,
  agendaItems,
  type BackupStatus,
  type BrokerRepository,
  type ContentRepository,
  type Listing,
  type ListingRepository,
  type MediaRepository,
  type MediaStorage,
  type PendingReview,
  type PlatformAccountRepository,
  type PublicationRepository,
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

/** La matriz y la agenda miran las publicaciones activas y las terminadas de los últimos 30 días. */
export const TRACKING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Lo que espera la revisión del operador con `auto_publish` (spec F6 §4.10): en una propiedad
 * `ready` o `active` de un corredor con `auto_publish`, el texto vigente de un canal con la cuenta
 * conectada que no quedó aprobado (su revisión tenía errores, o lo editó el operador).
 */
async function pendingReviews(
  deps: TrackingRoutesDeps,
  listings: readonly Listing[],
  autoPublishBrokerIds: ReadonlySet<string>,
): Promise<PendingReview[]> {
  const reviews: PendingReview[] = [];
  const connectedByBroker = new Map<string, Set<string>>();
  for (const listing of listings) {
    if (!autoPublishBrokerIds.has(listing.brokerId)) continue;
    if (listing.status !== "ready" && listing.status !== "active") continue;
    let connected = connectedByBroker.get(listing.brokerId);
    if (connected === undefined) {
      const accounts = await deps.platformAccounts.listByBroker(listing.brokerId);
      connected = new Set(
        accounts.filter((account) => account.status === "connected").map((a) => a.platform),
      );
      connectedByBroker.set(listing.brokerId, connected);
    }
    for (const content of await deps.contents.listCurrent(listing.id)) {
      if (content.status !== "approved" && connected.has(content.platform)) {
        reviews.push({ listingId: listing.id, platform: content.platform });
      }
    }
  }
  return reviews;
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
      const autoPublishBrokerIds = new Set(
        (await deps.brokers.list()).filter((b) => b.autoPublish).map((b) => b.id),
      );
      const backup =
        deps.backupStatus === undefined ? undefined : await deps.backupStatus().catch(() => null);
      const body: AgendaResponse = {
        items: agendaItems({
          listings,
          publications: await publicationsOf(listings, at),
          autoPublishBrokerIds,
          pendingReviews: await pendingReviews(deps, listings, autoPublishBrokerIds),
          ...(backup === undefined ? {} : { backup }),
          now: at,
        }),
      };
      return c.json(body, 200);
    });
}
