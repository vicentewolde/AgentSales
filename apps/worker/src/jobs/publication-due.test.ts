import { type Publication, schedulePublication } from "@agentsales/core";
import { createInMemoryJobQueue, createPublicationScenario } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  enqueuePublicationDue,
  PUBLICATION_DUE_KEY,
  PUBLICATION_DUE_QUEUE,
  PUBLICATION_DUE_SCHEDULE,
  publicationDueJob,
} from "./publication-due.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const AT = new Date("2026-10-19T13:00:00.000Z");

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
  const run = () => work?.([{ id: "job-1", data: {}, retryCount: 0, retryLimit: 0 }]);
  return { boss, bossCalls, run };
}

async function setup(now: Date) {
  const t = await createPublicationScenario();
  const { logger, lines } = captureLogger();
  const boss = fakeBoss();
  const job = publicationDueJob({ ...t.deps, publications: t.publications, now: () => now });
  await registerJobs(boss.boss, [job], logger);
  const schedule = (publication: Publication, dryRun: boolean) =>
    schedulePublication(
      { ...t.deps, now: () => NOW },
      { publicationId: publication.id, at: AT, dryRun, actor: "operator" },
    );
  return { t, lines, schedule, ...boss };
}

describe("publication.due", () => {
  it("la cola es exclusive con clave fija, sin reintentos, y el cron corre cada minuto en hora de Chile", async () => {
    const { bossCalls } = await setup(NOW);

    expect(PUBLICATION_DUE_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 120,
    });
    expect(bossCalls).toEqual([
      { name: "createQueue", args: ["publication.due", PUBLICATION_DUE_QUEUE] },
      {
        name: "schedule",
        args: [
          "publication.due",
          "* * * * *",
          {},
          { tz: "America/Santiago", missed: "skip", singletonKey: PUBLICATION_DUE_KEY },
        ],
      },
    ]);
    expect(PUBLICATION_DUE_SCHEDULE.singletonKey).toBe(PUBLICATION_DUE_KEY);
  });

  it("a la hora empieza la programada con su modo y registra solo ids", async () => {
    const { t, lines, schedule, run } = await setup(new Date("2026-10-19T13:00:30.000Z"));
    const post = t.byFormat("post") as Publication;
    await schedule(post, false);

    await run();

    expect(await t.publications.get(post.id)).toMatchObject({
      status: "publishing",
      dryRun: false,
    });
    expect(t.queue.jobs.map((job) => job.data)).toEqual([{ publicationId: post.id }]);
    expect(lines.find((line) => line.msg === "publicaciones programadas empezadas")).toMatchObject({
      publicationIds: [post.id],
    });
  });

  it("una vuelta sin nada que hacer no escribe en el log", async () => {
    const { lines, run } = await setup(NOW);
    await run();
    expect(lines.filter((line) => String(line.msg).includes("programadas"))).toEqual([]);
  });

  it("una que no se pudo empezar queda fallida y se avisa con su código", async () => {
    const { t, lines, schedule, run } = await setup(AT);
    const post = t.byFormat("post") as Publication;
    await schedule(post, true);
    await t.listings.changeStatus(t.listingId, "ready", "paused");

    await run();

    expect((await t.publications.get(post.id))?.status).toBe("failed");
    expect(
      lines.find((line) =>
        String(line.msg).startsWith("publicaciones programadas que no se pudieron empezar"),
      ),
    ).toMatchObject({ level: 40, failed: [{ publicationId: post.id, code: "LISTING_NOT_READY" }] });
  });

  it("la vuelta del arranque se encola con la misma clave", async () => {
    const queue = createInMemoryJobQueue();
    await enqueuePublicationDue(queue);
    expect(queue.jobs).toEqual([
      { name: "publication.due", data: {}, options: { singletonKey: PUBLICATION_DUE_KEY } },
    ]);
  });
});
