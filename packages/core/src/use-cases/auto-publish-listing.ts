import type { Broker } from "../broker.js";
import type { Content } from "../content.js";
import { LISTING_PLATFORMS, type Platform } from "../enums.js";
import { isAppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { PlatformAccount } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { type ApproveContentDeps, approveContent } from "./approve-content.js";
import { type PublishListingDeps, publishListing } from "./publish-listing.js";
import { type ScheduleDeps, scheduleChannel } from "./schedule-publications.js";

// `auto_publish` por corredor (spec F6 §4.10, D5, ADR-0019): al terminar una corrida de textos, la
// propiedad se aprueba y se publica sola, salvo lo que tiene errores o falta.

export type AutoPublishDeps = ApproveContentDeps &
  PublishListingDeps &
  Omit<ScheduleDeps, "publications"> & {
    brokers: Pick<BrokerRepository, "findById">;
    contents: Pick<ContentRepository, "get" | "listCurrent">;
    platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
    /**
     * El modo **del worker** (`PUBLISH_MODE`): es el único camino en que el worker fija el modo de
     * una publicación (spec F6 §4.10).
     */
    dryRun: boolean;
  };

/**
 * Qué pasó en un canal:
 * - `published`: Instagram o Portal empezaron a publicarse;
 * - `reminder`: Marketplace quedó programado para ahora (aparece en "te toca"; nunca abre Facebook);
 * - `approved`: se aprobó, pero le falta algo al aviso para publicar (`code`: `PORTAL_NOT_READY`,
 *   `MARKETPLACE_NOT_READY`…);
 * - `needs_review`: la revisión tiene errores; queda para el operador;
 * - `nothing_to_do`: ya estaba publicado o publicándose;
 * - `failed`: otro error (`code`, nunca datos del aviso).
 */
export type AutoPublishChannel = {
  platform: Platform;
  result: "published" | "reminder" | "approved" | "needs_review" | "nothing_to_do" | "failed";
  code?: string;
};

export type AutoPublishResult =
  /** El corredor no tiene `auto_publish`, o la propiedad no está en `ready` ni `active`. */
  { outcome: "off" } | { outcome: "done"; channels: AutoPublishChannel[] };

/**
 * Si `auto_publish` actúa sobre una propiedad (spec F6 §4.10): su corredor lo tiene y la propiedad
 * está `ready` o `active`. La misma regla la usa la agenda (`pendingReviewsOf`).
 */
export function autoPublishApplies(
  listing: Pick<Listing, "status">,
  broker: Pick<Broker, "autoPublish"> | null,
): boolean {
  return (
    broker?.autoPublish === true && (listing.status === "ready" || listing.status === "active")
  );
}

/** Los canales con la cuenta conectada (los únicos que `auto_publish` intenta). */
export function connectedPlatforms(
  accounts: readonly Pick<PlatformAccount, "platform" | "status">[],
): Set<Platform> {
  return new Set(
    accounts.filter((account) => account.status === "connected").map((a) => a.platform),
  );
}

/** El texto vigente de cada canal conectado, en el orden de `LISTING_PLATFORMS`. */
export function autoPublishContents<C extends Pick<Content, "platform">>(
  contents: readonly C[],
  connected: ReadonlySet<Platform>,
): C[] {
  return LISTING_PLATFORMS.flatMap((platform) => {
    const content = contents.find((item) => item.platform === platform);
    return content === undefined || !connected.has(platform) ? [] : [content];
  });
}

/** Lo que significa "ya está todo publicado": no es un fallo. */
const NOTHING_CODES = new Set(["NOTHING_TO_PUBLISH"]);
/** Lo que le falta al aviso para un canal: el texto queda aprobado y la agenda lo dice. */
const NOT_READY_CODES = new Set(["PORTAL_NOT_READY", "MARKETPLACE_NOT_READY", "CONTENT_NOT_READY"]);

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Aprueba y publica una propiedad sola (`content.prepare` lo llama al terminar bien con textos).
 * Si el corredor tiene `auto_publish` y la propiedad está en `ready` o `active`, por cada canal con
 * una cuenta conectada y un texto vigente:
 * 1. aprueba el texto (`approveContent`, actor `system`); con errores en la revisión, nada más;
 * 2. Instagram y Portal: publica de inmediato (`publishListing`) con el modo del worker;
 *    Marketplace: lo programa como recordatorio para ahora (`scheduleChannel`, sin margen).
 * Cada canal va por separado y **nunca lanza**: un error queda como `failed` con su código.
 */
export async function autoPublishListing(
  deps: AutoPublishDeps,
  { listingId }: { listingId: string },
): Promise<AutoPublishResult> {
  const listing = await deps.listings.get(listingId);
  if (listing === null) return { outcome: "off" };
  const broker = await deps.brokers.findById(listing.brokerId);
  if (!autoPublishApplies(listing, broker) || broker === null) return { outcome: "off" };

  const connected = connectedPlatforms(await deps.platformAccounts.listByBroker(broker.id));
  const channels: AutoPublishChannel[] = [];
  for (const content of autoPublishContents(
    await deps.contents.listCurrent(listingId),
    connected,
  )) {
    channels.push(
      await autoPublishChannel(deps, {
        listingId,
        platform: content.platform,
        contentId: content.id,
      }),
    );
  }
  return { outcome: "done", channels };
}

async function autoPublishChannel(
  deps: AutoPublishDeps,
  { listingId, platform, contentId }: { listingId: string; platform: Platform; contentId: string },
): Promise<AutoPublishChannel> {
  try {
    await approveContent(deps, { contentId, actor: "system" });
  } catch (error) {
    const code = codeOf(error);
    if (code === "CONTENT_HAS_ERRORS") return { platform, result: "needs_review" };
    if (NOT_READY_CODES.has(code)) return { platform, result: "approved", code };
    return { platform, result: "failed", code };
  }
  try {
    if (platform === "fb_marketplace") {
      const now = (deps.now ?? (() => new Date()))();
      await scheduleChannel(deps, {
        listingId,
        platform,
        at: now,
        dryRun: deps.dryRun,
        actor: "system",
        reason: "auto_publish",
        minLead: false,
      });
      return { platform, result: "reminder" };
    }
    await publishListing(deps, { listingId, platform, dryRun: deps.dryRun, actor: "system" });
    return { platform, result: "published" };
  } catch (error) {
    const code = codeOf(error);
    if (NOTHING_CODES.has(code)) return { platform, result: "nothing_to_do" };
    if (NOT_READY_CODES.has(code)) return { platform, result: "approved", code };
    return { platform, result: "failed", code };
  }
}
