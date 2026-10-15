import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { ListingImportData } from "../ports/listing-repository.js";
import { createPublicationScenario } from "../testing/index.js";
import { autoPublishListing } from "./auto-publish-listing.js";
import { startDuePublications } from "./start-due-publications.js";

// F6-T09 (spec F6 §4.10, ADR-0019): `auto_publish` por corredor.

// La hora real: el token de Portal del escenario vence una hora después de crearlo.
const NOW = new Date();

async function setup(
  options: {
    platform?: "instagram" | "portal_inmobiliario" | "fb_marketplace";
    autoPublish?: boolean;
    dryRun?: boolean;
    queueFails?: () => AppError | undefined;
  } = {},
) {
  const t = await createPublicationScenario({
    platform: options.platform ?? "instagram",
    approve: false,
    ...(options.queueFails === undefined ? {} : { queueFails: options.queueFails }),
  });
  const listing = await t.listings.get(t.listingId);
  if (listing === null) throw new Error("falta el aviso");
  if (options.autoPublish ?? true) await t.brokers.setAutoPublish(listing.brokerId, true);
  const deps = {
    ...t.deps,
    brokers: t.brokers,
    contents: t.contents,
    platformAccounts: t.platformAccounts,
    marketplace: { ufConfigured: true },
    dryRun: options.dryRun ?? true,
    now: () => NOW,
  };
  const run = () => autoPublishListing(deps, { listingId: t.listingId });
  return { t, deps, run };
}

describe("autoPublishListing", () => {
  it("un corredor sin auto_publish no hace nada", async () => {
    const { t, run } = await setup({ autoPublish: false });
    expect(await run()).toEqual({ outcome: "off" });
    expect(t.publications.all()).toEqual([]);
  });

  it("una propiedad que no está en ready ni active no hace nada", async () => {
    const { t, run } = await setup();
    t.listings.setStatus(t.listingId, "paused");
    expect(await run()).toEqual({ outcome: "off" });
    expect(t.publications.all()).toEqual([]);
  });

  it("Instagram: aprueba y publica con el actor system y el modo del worker", async () => {
    const { t, run } = await setup({ dryRun: false });

    expect(await run()).toEqual({
      outcome: "done",
      channels: [{ platform: "instagram", result: "published" }],
    });

    const publications = t.publications.all();
    expect(publications.length).toBeGreaterThan(0);
    for (const publication of publications) {
      expect(publication).toMatchObject({ status: "publishing", dryRun: false });
      expect((await t.publications.listEvents(publication.id)).at(-1)).toMatchObject({
        actor: "system",
      });
    }
    expect(t.queue.jobs.filter((job) => job.name === "publication.publish")).toHaveLength(
      publications.length,
    );
    expect((await t.contents.get(await t.instagramId()))?.status).toBe("approved");
  });

  it("con errores en la revisión solo la deja para el operador", async () => {
    const { t, run } = await setup();
    await t.locked.contents.update(await t.instagramId(), {
      body: "Departamento con 99 estacionamientos",
      status: "edited",
    });

    expect(await run()).toEqual({
      outcome: "done",
      channels: [{ platform: "instagram", result: "needs_review" }],
    });
    expect(t.publications.all()).toEqual([]);
  });

  it("ya publicada no es un fallo", async () => {
    const { t, run } = await setup();
    await run();
    for (const publication of t.publications.all()) {
      await t.publications.transition(
        publication.id,
        { from: "publishing", to: "published", changes: { externalId: `x-${publication.id}` } },
        { actor: "system" },
      );
    }

    expect(await run()).toEqual({
      outcome: "done",
      channels: [{ platform: "instagram", result: "nothing_to_do" }],
    });
  });

  it("Portal con lo que falta solo aprueba", async () => {
    const { t, run } = await setup({ platform: "portal_inmobiliario" });
    const listing = await t.listings.get(t.listingId);
    await t.listings.update(t.listingId, {
      ...listing,
      comuna: null,
      sourceHash: "h",
    } as unknown as ListingImportData);

    expect(await run()).toEqual({
      outcome: "done",
      channels: [{ platform: "portal_inmobiliario", result: "approved", code: "PORTAL_NOT_READY" }],
    });
    expect(t.publications.all().map((p) => p.status)).toEqual(["approved"]);
  });

  it("Marketplace queda programado para ahora como recordatorio, y el disparo no lo toca", async () => {
    const { t, deps, run } = await setup({ platform: "fb_marketplace" });

    expect(await run()).toEqual({
      outcome: "done",
      channels: [{ platform: "fb_marketplace", result: "reminder" }],
    });
    const [scheduled] = t.publications.all();
    expect(scheduled).toMatchObject({ status: "scheduled", dryRun: true });
    expect(scheduled?.scheduledAt?.getTime()).toBe(Math.floor(NOW.getTime() / 60_000) * 60_000);
    expect((await t.publications.listEvents(scheduled?.id ?? "")).at(-1)?.payload).toMatchObject({
      reason: "auto_publish",
    });

    const due = await startDuePublications({
      ...deps,
      publications: t.publications,
      now: () => new Date(NOW.getTime() + 60_000),
    });
    expect(due.started).toEqual([]);
    expect(t.publications.all()[0]?.status).toBe("scheduled");
  });

  it("un fallo no se lanza: queda con su código", async () => {
    const { run } = await setup({
      queueFails: () => new AppError("QUEUE_UNAVAILABLE", "sin cola", { retriable: true }),
    });

    expect(await run()).toEqual({
      outcome: "done",
      channels: [{ platform: "instagram", result: "failed", code: "QUEUE_UNAVAILABLE" }],
    });
  });
});
