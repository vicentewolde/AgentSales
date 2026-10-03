import { describe, expect, it } from "vitest";
import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import type { ListingStatus } from "../enums.js";
import { AppError } from "../errors.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import {
  createInMemoryContentRepositories,
  createInMemoryJobQueue,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "../testing/index.js";
import { requestContentRun } from "./request-content-run.js";

async function setup(
  options: { status?: ListingStatus; photos?: number; queueDown?: boolean } = {},
) {
  const listings = createInMemoryListingRepository();
  const listing = await listings.create({
    brokerId: "broker-1",
    category: "real_estate",
    source: "xlsx",
    externalRef: "P001",
    operation: "sale",
    propertyType: "Departamento",
    region: null,
    comuna: "Ñuñoa",
    address: null,
    unitNumber: null,
    showExactAddress: false,
    priceAmount: 5800,
    priceCurrency: "UF",
    highlights: null,
    internalNotes: null,
    attributes: {},
    sourceHash: "h",
  });
  if (options.status !== "draft") listings.setStatus(listing.id, options.status ?? "ready");
  const media = createInMemoryMediaRepository();
  for (let i = 0; i < (options.photos ?? 1); i += 1) {
    await media.create({
      listingId: listing.id,
      brokerId: "broker-1",
      kind: "image",
      storagePath: `foto-${i}`,
      mime: "image/jpeg",
      bytes: 1,
      checksum: `sha-${i}`,
      sortOrder: i,
      isCover: false,
    });
  }
  const repos = createInMemoryContentRepositories();
  const queue = createInMemoryJobQueue({
    fail: () =>
      options.queueDown
        ? new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true })
        : undefined,
  });
  const deps = {
    listings,
    media,
    contentRuns: repos.contentRuns,
    contents: repos.contents,
    queue,
  };
  return { deps, listingId: listing.id, repos, queue };
}

/** Deja un texto vigente de cada canal, el de Instagram editado a mano. */
async function withEditedContent(t: Awaited<ReturnType<typeof setup>>) {
  const run = await t.repos.contentRuns.create({ listingId: t.listingId, texts: true });
  await t.repos.contentRuns.markRunning(run.id);
  await t.repos.contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: (["instagram", "portal_inmobiliario", "fb_marketplace"] as const).map((platform) => ({
      platform,
      title: null,
      body: "texto",
      hashtags: [],
      llmProvider: "fake",
      llmModel: "m",
      promptVersion: "v",
      rawOutput: SAMPLE_CONTENT_DRAFT,
    })),
  });
  const [instagram] = await t.repos.contents.listCurrent(t.listingId);
  await t.repos.contents.update(instagram?.id ?? "", { body: "a mano", status: "edited" });
}

describe("requestContentRun", () => {
  it("crea la corrida en queued y encola content.prepare con su id como singletonKey", async () => {
    const t = await setup();

    const { run, reused } = await requestContentRun(t.deps, { listingId: t.listingId });

    expect(reused).toBe(false);
    expect(run).toMatchObject({ status: "queued", texts: true, listingId: t.listingId });
    expect(t.queue.jobs).toEqual([
      {
        name: "content.prepare",
        data: { contentRunId: run.id },
        options: { singletonKey: run.id },
      },
    ]);
  });

  it.each([
    ["en borrador", { status: "draft" as const }],
    ["archivado", { status: "archived" as const }],
    ["sin fotos", { photos: 0 }],
  ])("un aviso %s → LISTING_NOT_READY, sin crear nada", async (_, options) => {
    const t = await setup(options);

    await expect(requestContentRun(t.deps, { listingId: t.listingId })).rejects.toMatchObject({
      code: "LISTING_NOT_READY",
    });
    expect(await t.repos.contentRuns.latest(t.listingId)).toBeNull();
    expect(t.queue.jobs).toEqual([]);
  });

  it("un aviso que no existe → LISTING_NOT_FOUND", async () => {
    const t = await setup();
    await expect(requestContentRun(t.deps, { listingId: "nadie" })).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
    });
  });

  it("con una corrida activa la devuelve (con su texts) y la vuelve a encolar, en cola o corriendo", async () => {
    const t = await setup();
    const first = await requestContentRun(t.deps, { listingId: t.listingId, texts: false });

    const again = await requestContentRun(t.deps, { listingId: t.listingId, texts: true });
    expect(again).toEqual({ run: first.run, reused: true });
    expect(t.queue.jobs).toHaveLength(2);

    // En `running` también: si su último intento se cortó al apagar, ya no tiene job. La cola
    // `exclusive` no duplica uno que siga en cola, en reintento o activo.
    await t.repos.contentRuns.markRunning(first.run.id);
    const running = await requestContentRun(t.deps, { listingId: t.listingId });
    expect(running.reused).toBe(true);
    expect(running.run.status).toBe("running");
    expect(t.queue.jobs).toHaveLength(3);
    expect(t.queue.jobs.at(-1)).toEqual({
      name: "content.prepare",
      data: { contentRunId: first.run.id },
      options: { singletonKey: first.run.id },
    });
  });

  it("si otra petición gana la carrera (CONTENT_RUN_CONFLICT), devuelve la activa", async () => {
    const t = await setup();
    let winnerId = "";
    const racing: ContentRunRepository = {
      ...t.repos.contentRuns,
      // Nadie activa al revisar; al crear, otra petición ya ganó.
      findActive: async (listingId) =>
        winnerId === "" ? null : t.repos.contentRuns.findActive(listingId),
      create: async (run) => {
        winnerId = (await t.repos.contentRuns.create(run)).id;
        return t.repos.contentRuns.create(run);
      },
    };

    const result = await requestContentRun(
      { ...t.deps, contentRuns: racing },
      { listingId: t.listingId },
    );
    expect(result.reused).toBe(true);
    expect(result.run.id).toBe(winnerId);
  });

  it("con textos editados a mano: CONTENT_EDITED, salvo replaceEdits o sin textos", async () => {
    const t = await setup();
    await withEditedContent(t);

    await expect(requestContentRun(t.deps, { listingId: t.listingId })).rejects.toMatchObject({
      code: "CONTENT_EDITED",
      details: { platforms: ["instagram"] },
    });
    const onlyMedia = await requestContentRun(t.deps, { listingId: t.listingId, texts: false });
    expect(onlyMedia.run.texts).toBe(false);
    await t.repos.contentRuns.markFailed(onlyMedia.run.id, { code: "X", message: "x" });

    const replaced = await requestContentRun(t.deps, {
      listingId: t.listingId,
      replaceEdits: true,
    });
    expect(replaced).toMatchObject({ reused: false, run: { texts: true } });
  });

  it("con la cola caída, la corrida nueva queda en failed con QUEUE_UNAVAILABLE", async () => {
    const t = await setup({ queueDown: true });

    await expect(requestContentRun(t.deps, { listingId: t.listingId })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    expect(await t.repos.contentRuns.latest(t.listingId)).toMatchObject({
      status: "failed",
      error: { code: "QUEUE_UNAVAILABLE" },
    });
  });
});
