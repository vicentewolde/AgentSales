import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import { LISTING_MANUAL_TRANSITIONS } from "../listing.js";
import { createInMemoryListingRepository } from "../testing/import-repositories.js";
import { createInMemoryMediaRepository } from "../testing/media.js";
import { changeListingStatus } from "./change-listing-status.js";

const LISTING = {
  brokerId: "broker-1",
  externalRef: "P001",
  category: "real_estate" as const,
  source: "xlsx" as const,
  operation: "sale" as const,
  propertyType: null,
  region: null,
  comuna: null,
  address: null,
  unitNumber: null,
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF" as const,
  highlights: null,
  internalNotes: null,
  attributes: {},
  sourceHash: "hash",
};

async function setup(kind?: "image" | "video") {
  const listings = createInMemoryListingRepository();
  const media = createInMemoryMediaRepository();
  const { id } = await listings.create(LISTING);
  if (kind !== undefined) {
    await media.create({
      listingId: id,
      brokerId: "broker-1",
      kind,
      storagePath: `p/${kind}`,
      mime: kind === "image" ? "image/jpeg" : "video/mp4",
      bytes: 10,
      checksum: kind,
      sortOrder: 0,
      isCover: false,
    });
  }
  return { deps: { listings, media }, id, listings };
}

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("changeListingStatus", () => {
  it("las transiciones manuales: solo hacia ready, paused o archived; active y closed no se tocan", () => {
    const targets = new Set(Object.values(LISTING_MANUAL_TRANSITIONS).flat());
    expect([...targets].sort()).toEqual(["archived", "paused", "ready"]);
    expect(LISTING_MANUAL_TRANSITIONS.active).toEqual([]);
    expect(LISTING_MANUAL_TRANSITIONS.closed).toEqual([]);
  });

  it("un video no basta para ready", async () => {
    const { deps, id } = await setup("video");
    const error = await caught(changeListingStatus(deps, { listingId: id, status: "ready" }));
    expect(isAppError(error) && error.code).toBe("INVALID_TRANSITION");
  });

  it("si el estado cambió entre la lectura y la escritura: INVALID_TRANSITION, sin pisar", async () => {
    const { deps, id, listings } = await setup("image");
    deps.listings.changeStatus = async () => {
      listings.setStatus(id, "archived");
      return false;
    };

    const error = await caught(changeListingStatus(deps, { listingId: id, status: "ready" }));

    expect(isAppError(error) && error.code).toBe("INVALID_TRANSITION");
    expect((await listings.get(id))?.status).toBe("archived");
  });

  it("un aviso archivado con fotos se puede reactivar a ready", async () => {
    const { deps, id, listings } = await setup("image");
    listings.setStatus(id, "archived");
    expect((await changeListingStatus(deps, { listingId: id, status: "ready" })).status).toBe(
      "ready",
    );
  });
});
