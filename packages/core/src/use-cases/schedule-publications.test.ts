import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { Publication } from "../publication.js";
import { createPublicationScenario, type PublicationScenario } from "../testing/index.js";
import {
  marketplaceReminderNotes,
  type ScheduleListingOutcome,
  scheduleListings,
  schedulePublication,
  unschedulePublication,
} from "./schedule-publications.js";
import { startPublication } from "./start-publication.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const AT = new Date("2026-10-19T13:00:00.000Z");

const deps = (t: PublicationScenario, now = NOW) => ({ ...t.deps, now: () => now });

const scheduleOne = (t: PublicationScenario, id: string, at = AT, dryRun = true) =>
  schedulePublication(deps(t), { publicationId: id, at, dryRun, actor: "operator" });

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : "otro";
  }
  return null;
};

describe("schedulePublication", () => {
  it("programa una aprobada a la hora pedida (al minuto), con el modo de la API y sin encolar nada", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;

    const scheduled = await scheduleOne(t, post.id, new Date("2026-10-19T13:00:42.000Z"), false);

    expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: AT, dryRun: false });
    expect(t.queue.jobs).toEqual([]);
    expect((await t.publications.listEvents(post.id)).at(-1)).toMatchObject({
      type: "status_changed",
      fromStatus: "approved",
      toStatus: "scheduled",
      actor: "operator",
      payload: { mode: "live", scheduledAt: AT.toISOString(), reason: "operator" },
    });
  });

  it("reprograma una programada con schedule_changed; a la misma hora y modo no cambia nada", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await scheduleOne(t, post.id);
    const later = new Date("2026-10-20T09:30:00.000Z");

    const moved = await scheduleOne(t, post.id, later, false);
    expect(moved).toMatchObject({ status: "scheduled", scheduledAt: later, dryRun: false });
    const events = await t.publications.listEvents(post.id);
    expect(events.at(-1)).toMatchObject({
      type: "schedule_changed",
      payload: { from: AT.toISOString(), to: later.toISOString(), mode: "live" },
    });

    await scheduleOne(t, post.id, later, false);
    expect(await t.publications.listEvents(post.id)).toHaveLength(events.length);
  });

  it("programa un reintento desde failed", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await t.publications.transition(
      post.id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.publications.transition(
      post.id,
      { from: "publishing", to: "failed" },
      { actor: "system" },
    );

    expect(await scheduleOne(t, post.id)).toMatchObject({ status: "scheduled", scheduledAt: AT });
  });

  it("rechaza una hora muy cercana, muy lejana o inválida, sin tocar la publicación", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;

    expect(await codeOf(scheduleOne(t, post.id, new Date("2026-10-19T12:01:00.000Z")))).toBe(
      "SCHEDULE_TOO_SOON",
    );
    expect(await codeOf(scheduleOne(t, post.id, new Date("2026-12-19T12:00:00.000Z")))).toBe(
      "SCHEDULE_TOO_FAR",
    );
    expect(await codeOf(scheduleOne(t, post.id, new Date("x")))).toBe("SCHEDULE_AT_INVALID");
    expect((await t.publications.get(post.id))?.status).toBe("approved");
  });

  it("revisa lo mismo que publicar: una propiedad pausada no se programa", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await t.listings.changeStatus(t.listingId, "ready", "paused");

    expect(await codeOf(scheduleOne(t, post.id))).toBe("LISTING_NOT_READY");
    expect((await t.publications.get(post.id))?.status).toBe("approved");
  });

  it("una que se está publicando es PUBLICATION_IN_PROGRESS; una descartada, INVALID_TRANSITION", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    const reel = t.byFormat("reel") as Publication;
    await t.publications.transition(
      post.id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.publications.transition(
      reel.id,
      { from: "approved", to: "cancelled" },
      { actor: "operator" },
    );

    expect(await codeOf(scheduleOne(t, post.id))).toBe("PUBLICATION_IN_PROGRESS");
    expect(await codeOf(scheduleOne(t, reel.id))).toBe("INVALID_TRANSITION");
    expect(await codeOf(scheduleOne(t, "no-existe"))).toBe("PUBLICATION_NOT_FOUND");
  });

  it("Marketplace se programa como recordatorio aunque hoy se haya llegado al límite (spec F6 §4.3)", async () => {
    const t = await createPublicationScenario({ platform: "fb_marketplace", clock: () => NOW });
    const post = t.byFormat("post") as Publication;
    // Tres intentos en vivo hoy: el límite del día (D8 de F5).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await t.publications.addEvent(post.id, {
        type: "publish_attempt",
        actor: "system",
        payload: { mode: "live", attempt, retry: 0, result: "failed" },
      });
    }
    const marketplace = { ufConfigured: true };

    expect(
      await codeOf(
        startPublication(
          { ...deps(t), marketplace },
          { publicationId: post.id, dryRun: false, actor: "operator" },
        ),
      ),
    ).toBe("MARKETPLACE_DAILY_LIMIT");
    const scheduled = await schedulePublication(
      { ...deps(t), marketplace },
      { publicationId: post.id, at: AT, dryRun: false, actor: "operator" },
    );
    expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: AT });
  });

  it("publicar ahora adelanta una programada: pasa a publishing y borra la hora (D13)", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await scheduleOne(t, post.id);

    const started = await startPublication(deps(t), {
      publicationId: post.id,
      dryRun: true,
      actor: "operator",
    });
    expect(started.publication).toMatchObject({ status: "publishing", scheduledAt: null });
    expect(t.queue.jobs).toHaveLength(1);
  });
});

describe("unschedulePublication", () => {
  it("vuelve a approved y deja el texto aprobado; otra cosa es INVALID_TRANSITION", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await scheduleOne(t, post.id);

    const back = await unschedulePublication(t.deps, { publicationId: post.id, actor: "cli" });
    expect(back).toMatchObject({ status: "approved", scheduledAt: null });
    expect((await t.contents.get(post.contentId))?.status).toBe("approved");
    expect(
      await codeOf(unschedulePublication(t.deps, { publicationId: post.id, actor: "cli" })),
    ).toBe("INVALID_TRANSITION");
  });
});

describe("scheduleListings", () => {
  it("sin canales pedidos programa los que tienen texto aprobado y cuenta, y calla los demás", async () => {
    const t = await createPublicationScenario();

    const { results, notes } = await scheduleListings(deps(t), {
      listingIds: [t.listingId],
      at: AT,
      dryRun: true,
      actor: "operator",
    });

    expect(notes).toEqual([]);
    expect(results).toHaveLength(1);
    const [only] = results;
    expect(only).toMatchObject({ platform: "instagram", outcome: "scheduled", at: AT });
    expect(
      only?.outcome === "scheduled" && only.publications.map((p) => [p.format, p.status]),
    ).toEqual([
      ["post", "scheduled"],
      ["reel", "scheduled"],
    ]);
    expect(
      (await t.publications.listEvents(t.byFormat("post")?.id ?? "")).at(-1)?.payload,
    ).toMatchObject({ reason: "operator" });
  });

  it("con canales pedidos informa los que no se pudieron programar", async () => {
    const t = await createPublicationScenario();

    const { results } = await scheduleListings(deps(t), {
      listingIds: [t.listingId],
      platforms: ["instagram", "portal_inmobiliario"],
      at: AT,
      dryRun: true,
      actor: "operator",
    });

    expect(results.map((r) => [r.platform, r.outcome])).toEqual([
      ["instagram", "scheduled"],
      ["portal_inmobiliario", "skipped"],
    ]);
    expect(results[1]).toMatchObject({ code: "CONTENT_NOT_APPROVED" });
  });

  it("una propiedad que falla no corta el lote, y el espaciado corre por propiedad", async () => {
    const t = await createPublicationScenario();

    const { results } = await scheduleListings(deps(t), {
      listingIds: ["no-existe", t.listingId],
      platforms: ["instagram"],
      at: AT,
      spacingMinutes: 30,
      dryRun: true,
      actor: "cli",
    });

    expect(results.map((r) => [r.listingId, r.outcome])).toEqual([
      ["no-existe", "skipped"],
      [t.listingId, "scheduled"],
    ]);
    expect(results[0]).toMatchObject({ code: "LISTING_NOT_FOUND" });
    const later = new Date(AT.getTime() + 30 * 60_000);
    expect(results[1]).toMatchObject({ at: later });
    expect(t.byFormat("post")).toMatchObject({ scheduledAt: later });
    expect(
      (await t.publications.listEvents(t.byFormat("post")?.id ?? "")).at(-1)?.payload,
    ).toMatchObject({ reason: "batch" });
  });

  it("una propiedad sin canales posibles queda informada", async () => {
    const t = await createPublicationScenario({ account: false });

    const { results } = await scheduleListings(deps(t), {
      listingIds: [t.listingId],
      at: AT,
      dryRun: true,
      actor: "operator",
    });

    expect(results).toEqual([
      {
        listingId: t.listingId,
        platform: null,
        outcome: "skipped",
        code: "NOTHING_TO_PUBLISH",
        message: expect.stringContaining("no tiene canales"),
      },
    ]);
  });

  it("un pedido inválido es SCHEDULE_BATCH_INVALID; la última hora del lote tampoco pasa de 60 días", async () => {
    const t = await createPublicationScenario();
    const base = { at: AT, dryRun: true, actor: "operator" as const };

    expect(await codeOf(scheduleListings(deps(t), { ...base, listingIds: [] }))).toBe(
      "SCHEDULE_BATCH_INVALID",
    );
    expect(
      await codeOf(scheduleListings(deps(t), { ...base, listingIds: [t.listingId, t.listingId] })),
    ).toBe("SCHEDULE_BATCH_INVALID");
    expect(
      await codeOf(
        scheduleListings(deps(t), { ...base, listingIds: [t.listingId], spacingMinutes: 241 }),
      ),
    ).toBe("SCHEDULE_BATCH_INVALID");
    expect(
      await codeOf(
        scheduleListings(deps(t), {
          ...base,
          at: new Date("2026-12-18T11:00:00.000Z"),
          listingIds: [t.listingId, "otra"],
          spacingMinutes: 120,
        }),
      ),
    ).toBe("SCHEDULE_TOO_FAR");
    expect((await t.publications.get(t.byFormat("post")?.id ?? ""))?.status).toBe("approved");
  });
});

describe("marketplaceReminderNotes", () => {
  const reminder = (accountId: string, at: Date): ScheduleListingOutcome => ({
    listingId: `l-${accountId}-${at.toISOString()}`,
    platform: "fb_marketplace",
    outcome: "scheduled",
    at,
    publications: [{ platformAccountId: accountId } as Publication],
  });

  it("avisa más de 3 recordatorios de una cuenta en un mismo día de Chile", () => {
    // 01:00 UTC del 20 es todavía el 19 en Chile.
    const day = [10, 12, 14, 25].map((hour) =>
      reminder("a1", new Date(Date.UTC(2026, 9, 19, 0, 0) + hour * 3600_000)),
    );
    expect(marketplaceReminderNotes(day)).toEqual([expect.stringContaining("2026-10-19")]);
    expect(marketplaceReminderNotes(day.slice(0, 3))).toEqual([]);
    expect(
      marketplaceReminderNotes([
        ...day.slice(0, 3),
        reminder("a2", new Date("2026-10-19T15:00:00Z")),
      ]),
    ).toEqual([]);
  });
});
