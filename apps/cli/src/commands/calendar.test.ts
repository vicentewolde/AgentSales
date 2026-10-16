import { publishListing } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { publicationHarness } from "../../test/harness.js";
import { formatChileTime } from "../chile-time.js";
import { runAgenda } from "./agenda.js";
import { runAutoPublish } from "./brokers.js";
import { checkAutoPublish } from "./doctor/checks.js";
import { runListingAction } from "./listing.js";
import { runRelistPublication } from "./publications.js";
import { runSchedule, runUnschedule } from "./schedule.js";
import { renderAutoPublish } from "./status.js";
import { runTracking } from "./tracking.js";

// F6-T11 (spec F6 §4.3, §4.8, §4.9 y §4.10): la CLI del calendario y el seguimiento, sobre la API
// real en proceso.

const inHours = (hours: number) => formatChileTime(new Date(Date.now() + hours * 3_600_000));
const noQuestions = async () => {
  throw new Error("no debía preguntar");
};

async function setup(options: Parameters<typeof publicationHarness>[0] = {}) {
  const { h, t } = await publicationHarness(options);
  const listing = await t.listings.get(t.listingId);
  const ref = listing?.externalRef ?? "";
  const asked: string[] = [];
  const deps = (answer: boolean | null = null) => ({
    ...h.io,
    client: h.client,
    confirm:
      answer === null
        ? noQuestions
        : async (question: string) => {
            asked.push(question);
            return answer;
          },
  });
  return { h, t, ref, asked, deps };
}

describe("schedule y unschedule", () => {
  it("programa la propiedad a una hora de Chile y la muestra igual, ida y vuelta", async () => {
    const { h, t, ref, deps } = await setup();
    const at = inHours(3);

    expect(await runSchedule(deps(), [ref], { at, platform: ["instagram"] })).toBe(0);

    expect(h.text()).toContain(`${ref} Instagram: programada para ${at} (simulación)`);
    const scheduled = t.publications.all().filter((p) => p.status === "scheduled");
    expect(scheduled).toHaveLength(2);
    expect(formatChileTime(scheduled[0]?.scheduledAt ?? new Date(0))).toBe(at);
  });

  it("en vivo pregunta; si no, no programa nada", async () => {
    const { h, t, ref, asked, deps } = await setup({ publishMode: "live" });

    expect(await runSchedule(deps(false), [ref], { at: inHours(3) })).toBe(1);

    expect(asked[0]).toContain("EN VIVO");
    expect(h.errors()).toContain("No se programó nada");
    expect(t.publications.all().every((p) => p.status === "approved")).toBe(true);
  });

  it("--publication la programa y unschedule la deja aprobada", async () => {
    const { h, t, deps } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    expect(await runSchedule(deps(), [], { at: inHours(2), publication: id })).toBe(0);
    expect(t.byFormat("post")?.status).toBe("scheduled");
    expect(await runUnschedule(deps(), id)).toBe(0);
    expect(t.byFormat("post")?.status).toBe("approved");
    expect(h.text()).toContain("desprogramada");
  });

  it("una hora mal escrita o muy pronto se explica, sin programar", async () => {
    const { h, ref, deps } = await setup();
    expect(await runSchedule(deps(), [ref], { at: "mañana" })).toBe(1);
    expect(h.errors()).toContain("AAAA-MM-DD HH:MM");
    expect(await runSchedule(deps(), [ref], { at: formatChileTime(new Date()) })).toBe(1);
    expect(h.errors()).toContain("SCHEDULE_TOO_SOON");
  });
});

describe("agenda y tracking", () => {
  it("la agenda muestra cada ítem con el comando para resolverlo", async () => {
    const { h, t, ref, deps } = await setup();
    const reel = t.byFormat("reel")?.id ?? "";
    await t.publications.transition(
      reel,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.publications.transition(
      reel,
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "IG_AUTH_INVALID", message: "m", retriable: false } },
      },
      { actor: "system" },
    );
    await runSchedule(deps(), [], { at: inHours(5), publication: t.byFormat("post")?.id ?? "" });

    expect(await runAgenda(deps())).toBe(0);

    const text = h.text();
    expect(text).toContain("Fallaron (1)");
    expect(text).toContain("IG_AUTH_INVALID");
    expect(text).toContain(`→ agentsales publish ${ref} --platform instagram`);
    expect(text).toContain("Próximas (7 días) (1)");
    expect(text).toContain(`→ agentsales unschedule ${t.byFormat("post")?.id}`);
  });

  it("tracking en tabla y en JSON", async () => {
    const { h, ref, deps } = await setup();
    expect(await runTracking(deps())).toBe(0);
    expect(h.text()).toContain(ref);
    expect(h.text()).toContain("carrusel aprobada");
    h.out.length = 0;
    expect(await runTracking(deps(), { json: true })).toBe(0);
    expect(JSON.parse(h.text()).rows[0].listing.externalRef).toBe(ref);
  });
});

describe("listing (la propiedad manda)", () => {
  it("pausar con algo programado pregunta con el motivo de la API y, al confirmar, pausa", async () => {
    const { h, t, ref, asked, deps } = await setup();
    await runSchedule(deps(), [], { at: inHours(4), publication: t.byFormat("post")?.id ?? "" });

    expect(await runListingAction(deps(true), "pause", ref)).toBe(0);

    expect(asked[0]).toContain("Pausar la propiedad");
    expect(h.text()).toContain(`${ref} quedó pausada`);
    expect(t.byFormat("post")?.status).toBe("approved");
  });

  it("cerrar exige el motivo en español; con --yes no pregunta", async () => {
    const { h, t, ref, deps } = await setup();

    expect(await runListingAction(deps(), "close", ref, {})).toBe(1);
    expect(h.errors()).toContain("--reason vendida, arrendada, retirada");

    expect(await runListingAction(deps(), "close", ref, { reason: "Vendida", yes: true })).toBe(0);
    expect(await t.listings.get(t.listingId)).toMatchObject({
      status: "closed",
      closeReason: "sold",
    });
  });
});

describe("publications relist y brokers auto-publish", () => {
  it("republica un aviso de Portal cerrado (simulación)", async () => {
    const { h, t, deps } = await setup({ platform: "portal_inmobiliario" });
    const [started] = (
      await publishListing(t.deps, {
        listingId: t.listingId,
        platform: "portal_inmobiliario",
        dryRun: true,
        actor: "cli",
      })
    ).started;
    const id = started?.id ?? "";
    await t.publications.transition(
      id,
      { from: "publishing", to: "published", changes: { externalId: `dry-run:${id}` } },
      { actor: "system" },
    );
    await t.publications.transition(
      id,
      { from: "published", to: "unpublished" },
      { actor: "operator" },
    );

    expect(await runRelistPublication(deps(), id)).toBe(0);
    expect(h.text()).toContain("Republicación pedida");
    expect(t.publications.all().some((p) => p.relistedFrom === id)).toBe(true);
  });

  it("auto-publish pregunta siempre; en vivo avisa en rojo; status y doctor lo destacan", async () => {
    const { h, t, asked, deps } = await setup({ publishMode: "live" });
    const listing = await t.listings.get(t.listingId);
    const slug = (await t.brokers.findById(listing?.brokerId ?? ""))?.slug ?? "";

    expect(await runAutoPublish(deps(true), slug, "on")).toBe(0);

    expect(asked[0]).toContain(`¿Activar auto_publish de ${slug}?`);
    expect(h.errors()).toContain("publicará sin tu revisión");
    expect(h.text()).toContain(`auto_publish de ${slug}: activado`);
    const report = {
      status: "ok" as const,
      publishMode: "live" as const,
      version: "x",
      checks: {
        db: { ok: true, latencyMs: 1 },
        storage: { ok: true, latencyMs: 1 },
        queue: { ok: true, latencyMs: 1 },
      },
      autoPublishBrokers: [slug],
    };
    expect(renderAutoPublish(report, h.io.colors)).toContain("publica sin tu revisión");
    expect(checkAutoPublish(report)).toMatchObject({ level: "warn", emphasis: "danger" });
    expect(checkAutoPublish({ ...report, publishMode: "dry-run" })?.level).toBe("ok");
    expect(renderAutoPublish({ ...report, autoPublishBrokers: [] }, h.io.colors)).toBeNull();

    expect(await runAutoPublish(deps(false), slug, "off")).toBe(1);
    expect((await t.brokers.findById(listing?.brokerId ?? ""))?.autoPublish).toBe(true);
  });
});
