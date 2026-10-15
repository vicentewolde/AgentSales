import { type Publication, STALE_PUBLISHING_MS } from "@agentsales/core";
import { createPublicationScenario } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  PUBLICATIONS_WATCH_KEY,
  PUBLICATIONS_WATCH_QUEUE,
  PUBLICATIONS_WATCH_SCHEDULE,
  publicationsWatchJob,
} from "./publications-watch.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

/** Un pg-boss falso: guarda el handler, la cola creada y el cron. */
function fakeBoss() {
  const bossCalls: { name: string; args: unknown[] }[] = [];
  let work: Parameters<WorkerBoss["work"]>[2] | undefined;
  const boss: WorkerBoss = {
    createQueue: async (...args) => {
      bossCalls.push({ name: "createQueue", args });
    },
    updateQueue: async () => {},
    getQueue: async () => ({ policy: "exclusive" }),
    work: async (_name, _options, handler) => {
      work = handler;
      return "w1";
    },
    schedule: async (...args) => {
      bossCalls.push({ name: "schedule", args });
    },
  };
  const run = () => work?.([{ id: "job-1", data: {}, retryCount: 0, retryLimit: 1 }]);
  return { boss, bossCalls, run };
}

async function setup() {
  const t = await createPublicationScenario();
  const { logger, lines } = captureLogger();
  const boss = fakeBoss();
  const job = publicationsWatchJob({
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    queue: t.queue,
    now: () => new Date(Date.now() + STALE_PUBLISHING_MS + 60_000),
  });
  await registerJobs(boss.boss, [job], logger);
  return { t, lines, ...boss };
}

describe("publications.watch", () => {
  it("la cola es exclusive con clave fija y el cron corre cada hora en hora de Chile", async () => {
    const { bossCalls } = await setup();

    expect(PUBLICATIONS_WATCH_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 1,
      retryDelay: 60,
      retryBackoff: false,
      expireInSeconds: 300,
    });
    expect(bossCalls).toEqual([
      { name: "createQueue", args: ["publications.watch", PUBLICATIONS_WATCH_QUEUE] },
      {
        name: "schedule",
        args: [
          "publications.watch",
          "0 * * * *",
          {},
          { tz: "America/Santiago", missed: "skip", singletonKey: PUBLICATIONS_WATCH_KEY },
        ],
      },
    ]);
    expect(PUBLICATIONS_WATCH_SCHEDULE.singletonKey).toBe(PUBLICATIONS_WATCH_KEY);
  });

  it("reencola una atascada y lo registra con su id", async () => {
    const { t, lines, run } = await setup();
    const post = t.byFormat("post") as Publication;
    await t.publications.transition(
      post.id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "operator" },
    );

    await run();

    expect(t.queue.jobs.map((job) => job.data)).toEqual([{ publicationId: post.id }]);
    expect(
      lines.find(
        (line) => line.msg === "vigilancia: publicaciones atascadas en publicando, reencoladas",
      ),
    ).toMatchObject({ level: 40, publicationIds: [post.id] });
  });
});
