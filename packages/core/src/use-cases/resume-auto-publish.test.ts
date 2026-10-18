import { describe, expect, it } from "vitest";
import type { ContentRunReport } from "../content.js";
import { SCHEDULE_OVERDUE_MS } from "../schedule.js";
import { createInMemoryContentRepositories } from "../testing/content.js";
import type { AutoPublishDeps } from "./auto-publish-listing.js";
import { resumeCutAutoPublish } from "./resume-auto-publish.js";

// F8-T12 (spec F8 §4.10): un `auto_publish` cortado por un reinicio se retoma al arrancar.

const REPORT: ContentRunReport = { warnings: [] };

/**
 * `auto_publish` que anota cada propiedad que revisa (el corredor lo tiene apagado: no publica).
 * Un doble parcial: `resumeCutAutoPublish` solo usa el candado y lo que `autoPublishListing` lee
 * primero (la propiedad y el corredor).
 */
function recordingAutoPublish(publications: { createdAt: Date }[] = []) {
  const asked: string[] = [];
  const autoPublish = {
    listings: {
      get: async (id: string) => {
        asked.push(id);
        return { id, brokerId: "b", status: "ready" };
      },
    },
    brokers: { findById: async () => ({ id: "b", autoPublish: false }) },
    lock: {
      run: async (_id: string, fn: (locked: unknown) => Promise<unknown>) =>
        fn({ publications: { listByListing: async () => publications } }),
    },
  } as unknown as AutoPublishDeps;
  return { asked, autoPublish };
}

/** Una corrida con textos que terminó bien sin resolver su `auto_publish` (el corte). */
async function cutRun(repos = createInMemoryContentRepositories(), listingId = "listing-1") {
  const run = await repos.contentRuns.create({ listingId, texts: true });
  await repos.contentRuns.markRunning(run.id);
  await repos.contentRuns.markSucceeded(run.id, { report: REPORT, contents: [] });
  return { repos, runId: run.id, listingId };
}

describe("resumeCutAutoPublish", () => {
  it("se retoma una sola vez y no se duplica", async () => {
    const { repos, listingId } = await cutRun();
    const { asked, autoPublish } = recordingAutoPublish();
    const deps = { ...autoPublish, contentRuns: repos.contentRuns };

    expect(await resumeCutAutoPublish(deps)).toEqual([
      { listingId, outcome: "resumed", result: { outcome: "off" } },
    ]);
    expect(asked).toEqual([listingId]);
    // Un segundo arranque ya no la encuentra.
    expect(await resumeCutAutoPublish(deps)).toEqual([]);
    expect(asked).toEqual([listingId]);
  });

  it("una corrida que resolvió su auto_publish no queda pendiente", async () => {
    const { repos, runId } = await cutRun();
    await repos.contentRuns.markAutoPublishDone(runId);
    const { asked, autoPublish } = recordingAutoPublish();

    expect(await resumeCutAutoPublish({ ...autoPublish, contentRuns: repos.contentRuns })).toEqual(
      [],
    );
    expect(asked).toEqual([]);
  });

  it("no se retoma si la propiedad tiene publicaciones nuevas, y queda anotada", async () => {
    const { repos, listingId } = await cutRun();
    const touched = recordingAutoPublish([{ createdAt: new Date(Date.now() + 1000) }]);
    const deps = { ...touched.autoPublish, contentRuns: repos.contentRuns };

    expect(await resumeCutAutoPublish(deps)).toEqual([
      { listingId, outcome: "skipped", reason: "touched" },
    ]);
    expect(touched.asked).toEqual([]);
    expect(await resumeCutAutoPublish(deps)).toEqual([]);
  });

  it("no se retoma si terminó hace más de 12 h", async () => {
    const { repos } = await cutRun();
    const late = recordingAutoPublish();
    const now = new Date(Date.now() + SCHEDULE_OVERDUE_MS + 60_000);

    expect(
      await resumeCutAutoPublish({ ...late.autoPublish, contentRuns: repos.contentRuns }, { now }),
    ).toEqual([]);
    expect(late.asked).toEqual([]);
  });

  it("no se retoma si la propiedad tiene una corrida más nueva", async () => {
    const { repos, listingId } = await cutRun();
    await repos.contentRuns.create({ listingId, texts: true });
    const { asked, autoPublish } = recordingAutoPublish();

    expect(await resumeCutAutoPublish({ ...autoPublish, contentRuns: repos.contentRuns })).toEqual([
      { listingId, outcome: "skipped", reason: "superseded" },
    ]);
    expect(asked).toEqual([]);
  });

  it("una que falla no corta las demás", async () => {
    const repos = createInMemoryContentRepositories();
    const first = await cutRun(repos, "listing-1");
    const second = await cutRun(repos, "listing-2");
    const { asked, autoPublish } = recordingAutoPublish();
    const failing = {
      ...autoPublish,
      contentRuns: repos.contentRuns,
      lock: {
        run: async (id: string, fn: (locked: unknown) => Promise<unknown>) => {
          if (id === first.listingId) throw Object.assign(new Error("x"), { code: "IGNORED" });
          return fn({ publications: { listByListing: async () => [] } });
        },
      },
    } as unknown as Parameters<typeof resumeCutAutoPublish>[0];

    expect(await resumeCutAutoPublish(failing)).toEqual([
      { listingId: first.listingId, outcome: "failed", code: "INTERNAL_ERROR" },
      { listingId: second.listingId, outcome: "resumed", result: { outcome: "off" } },
    ]);
    expect(asked).toEqual([second.listingId]);
  });
});
