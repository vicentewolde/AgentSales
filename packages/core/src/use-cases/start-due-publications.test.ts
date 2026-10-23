import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { DueQuery } from "../ports/publication-repository.js";
import type { Publication } from "../publication.js";
import { SCHEDULE_OVERDUE_MS } from "../schedule.js";
import { createPublicationScenario, type PublicationScenario } from "../testing/index.js";
import { schedulePublication } from "./schedule-publications.js";
import { DUE_BATCH_LIMIT, dueQuery, startDuePublications } from "./start-due-publications.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const AT = new Date("2026-10-19T13:00:00.000Z");

const schedule = (t: PublicationScenario, id: string, dryRun: boolean, at = AT) =>
  schedulePublication(
    { ...t.deps, now: () => NOW },
    { publicationId: id, at, dryRun, actor: "operator" },
  );

const due = (t: PublicationScenario, now: Date) =>
  startDuePublications({ ...t.deps, publications: t.publications, now: () => now });

describe("dueQuery (la regla de lo vencido, también para el worker que se apaga solo)", () => {
  it("hasta ahora (o el margen), desde hace 12 h, sin Marketplace y con el tope", () => {
    expect(dueQuery(NOW)).toEqual({
      now: NOW,
      since: new Date(NOW.getTime() - SCHEDULE_OVERDUE_MS),
      excludePlatforms: ["fb_marketplace"],
      limit: DUE_BATCH_LIMIT,
    });
    expect(dueQuery(NOW, 70 * 60_000).now).toEqual(new Date(NOW.getTime() + 70 * 60_000));
  });
});

describe("startDuePublications", () => {
  it("empieza las vencidas con su propio modo, actor system, y las encola después del candado", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    const reel = t.byFormat("reel") as Publication;
    await schedule(t, post.id, false);
    await schedule(t, reel.id, true, new Date("2026-10-19T13:05:00.000Z"));

    const result = await due(t, new Date("2026-10-19T13:01:00.000Z"));

    expect(result).toEqual({
      started: [post.id],
      notQueued: [],
      failed: [],
      skipped: [],
      errors: [],
    });
    expect(await t.publications.get(post.id)).toMatchObject({
      status: "publishing",
      dryRun: false,
      attempts: 1,
      scheduledAt: null,
    });
    expect((await t.publications.get(reel.id))?.status).toBe("scheduled");
    expect(t.queue.jobs).toEqual([
      {
        name: "publication.publish",
        data: { publicationId: post.id },
        options: { singletonKey: post.id },
      },
    ]);
    expect((await t.publications.listEvents(post.id)).at(-1)).toMatchObject({
      fromStatus: "scheduled",
      toStatus: "publishing",
      actor: "system",
      payload: { mode: "live", attempt: 1 },
    });

    // La vuelta siguiente no la empieza de nuevo.
    const again = await due(t, new Date("2026-10-19T13:02:00.000Z"));
    expect(again.started).toEqual([]);
    expect(t.queue.jobs).toHaveLength(1);
  });

  it("una atrasada más de 12 h no sale sola: espera al operador", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await schedule(t, post.id, true);

    const late = new Date(AT.getTime() + SCHEDULE_OVERDUE_MS + 60_000);
    expect((await due(t, late)).started).toEqual([]);
    expect((await t.publications.get(post.id))?.status).toBe("scheduled");

    const justInTime = new Date(AT.getTime() + SCHEDULE_OVERDUE_MS);
    expect((await due(t, justInTime)).started).toEqual([post.id]);
  });

  it("un recordatorio de Marketplace nunca se dispara solo", async () => {
    const t = await createPublicationScenario({ platform: "fb_marketplace" });
    const post = t.byFormat("post") as Publication;
    await schedulePublication(
      { ...t.deps, now: () => NOW, marketplace: { ufConfigured: true } },
      { publicationId: post.id, at: AT, dryRun: true, actor: "operator" },
    );

    expect(await due(t, new Date("2026-10-19T13:30:00.000Z"))).toMatchObject({ started: [] });
    expect((await t.publications.get(post.id))?.status).toBe("scheduled");
    expect(t.queue.jobs).toEqual([]);
  });

  it("una que ya no se puede publicar queda failed con el motivo", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await schedule(t, post.id, true);
    await t.listings.changeStatus(t.listingId, "ready", "paused");

    const result = await due(t, new Date("2026-10-19T13:00:00.000Z"));

    expect(result.failed).toEqual([{ publicationId: post.id, code: "LISTING_NOT_READY" }]);
    expect(await t.publications.get(post.id)).toMatchObject({
      status: "failed",
      scheduledAt: null,
      lastError: { code: "LISTING_NOT_READY", retriable: false },
    });
    expect((await t.publications.listEvents(post.id)).at(-1)).toMatchObject({
      fromStatus: "scheduled",
      toStatus: "failed",
      actor: "system",
      payload: { due: true, code: "LISTING_NOT_READY" },
    });
    expect(t.queue.jobs).toEqual([]);
  });

  it("con la cola caída, la que empezó queda en publishing para la vigilancia", async () => {
    let down = true;
    const t = await createPublicationScenario({
      queueFails: () =>
        down ? new AppError("QUEUE_UNAVAILABLE", "cola caída", { retriable: true }) : undefined,
    });
    const post = t.byFormat("post") as Publication;
    await schedule(t, post.id, true);

    const result = await due(t, AT);
    down = false;

    expect(result).toMatchObject({ started: [], notQueued: [post.id] });
    expect((await t.publications.get(post.id))?.status).toBe("publishing");
  });

  it("con más de 20 atrasadas y recordatorios vencidos, una vencida normal igual sale en la primera vuelta", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await schedule(t, post.id, true);
    const now = new Date(AT.getTime() + 60_000);
    const oldAt = new Date(AT.getTime() - SCHEDULE_OVERDUE_MS - 60 * 60_000);
    // 25 atrasadas (de hace más de 12 h) y 25 recordatorios de Marketplace en la ventana, de otras
    // propiedades: van antes por hora, pero la consulta los deja fuera.
    for (let index = 0; index < 50; index += 1) {
      const marketplace = index % 2 === 1;
      const created = await t.publications.create(
        {
          listingId: `otra-${index}`,
          platformAccountId: post.platformAccountId,
          platform: marketplace ? "fb_marketplace" : "instagram",
          format: "post",
          contentId: post.contentId,
          mediaIds: [],
          listingSourceHash: "h",
        },
        { actor: "operator" },
      );
      await t.publications.transition(
        created.id,
        {
          from: "approved",
          to: "scheduled",
          changes: {
            dryRun: true,
            scheduledAt: marketplace ? new Date(AT.getTime() - 60 * 60_000) : oldAt,
          },
        },
        { actor: "operator" },
      );
    }

    const result = await due(t, now);

    expect(result.started).toEqual([post.id]);
    expect(t.publications.all().filter((p) => p.status === "scheduled")).toHaveLength(50);
  });

  it("aunque la consulta dejara pasar un recordatorio de Marketplace, no lo empieza", async () => {
    const t = await createPublicationScenario({ platform: "fb_marketplace" });
    const post = t.byFormat("post") as Publication;
    await schedulePublication(
      { ...t.deps, now: () => NOW, marketplace: { ufConfigured: true } },
      { publicationId: post.id, at: AT, dryRun: true, actor: "operator" },
    );
    const leaky = {
      async listDue() {
        return [(await t.publications.get(post.id)) as Publication];
      },
    };

    const result = await startDuePublications({ ...t.deps, publications: leaky, now: () => AT });

    expect(result).toMatchObject({ started: [], skipped: [post.id] });
    expect((await t.publications.get(post.id))?.status).toBe("scheduled");
  });

  it("pide las vencidas de las últimas 12 h, sin Marketplace y con tope, en la consulta", async () => {
    const t = await createPublicationScenario();
    const queries: DueQuery[] = [];
    await startDuePublications({
      ...t.deps,
      publications: {
        async listDue(query) {
          queries.push(query);
          return [];
        },
      },
      now: () => NOW,
    });
    expect(queries).toEqual([
      {
        now: NOW,
        since: new Date(NOW.getTime() - SCHEDULE_OVERDUE_MS),
        excludePlatforms: ["fb_marketplace"],
        limit: DUE_BATCH_LIMIT,
      },
    ]);
  });

  it("un error pasajero en una no corta las demás y la deja programada", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    const reel = t.byFormat("reel") as Publication;
    await schedule(t, post.id, true);
    await schedule(t, reel.id, true);
    const failing = {
      ...t.deps.lock,
      async run<T>(listingId: string, fn: Parameters<typeof t.deps.lock.run<T>>[1]) {
        if (failing.calls++ === 0)
          throw new AppError("DB_UNAVAILABLE", "base caída", { retriable: true });
        return t.deps.lock.run(listingId, fn);
      },
      calls: 0,
    };

    const result = await startDuePublications({
      ...t.deps,
      lock: failing,
      publications: t.publications,
      now: () => AT,
    });

    expect(result.errors).toEqual([{ publicationId: post.id, code: "DB_UNAVAILABLE" }]);
    expect(result.started).toEqual([reel.id]);
    expect((await t.publications.get(post.id))?.status).toBe("scheduled");
  });
});
