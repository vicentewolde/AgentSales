import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import { createPostPublicationScenario } from "../testing/index.js";
import { recordExternalPublication } from "./record-external-publication.js";

const NOW = new Date("2026-11-11T15:00:00Z");
const URL = "https://x.com/agentpeyai/status/1855555555555555555";
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => (isAppError(e) ? e.code : e),
  );
const scenario = () =>
  createPostPublicationScenario({ texts: [{ platform: "x", language: "es" }] });
const run = (
  t: Awaited<ReturnType<typeof scenario>>,
  extra: Partial<Parameters<typeof recordExternalPublication>[1]> = {},
) =>
  recordExternalPublication(
    { ...t.subjectDeps, now: () => NOW },
    { postId: t.post.id, platform: "x", language: "es", url: URL, actor: "operator", ...extra },
  );

describe("recordExternalPublication", () => {
  it("crea una publicación real publicada con el enlace y la fecha", async () => {
    const t = await scenario();
    // Sin ninguna publicación previa (el texto aprobado abrió una `approved`, que se descarta).
    const when = new Date("2026-11-10T12:00:00Z");
    const { publication, superseded } = await run(t, { publishedAt: when });
    expect(publication).toMatchObject({
      status: "published",
      dryRun: false,
      externalId: "1855555555555555555",
      externalUrl: URL,
      publishedAt: when,
    });
    expect(superseded.map((p) => p.status)).toEqual(["cancelled"]);
    const events = await t.publications.listEvents(publication.id);
    expect(events.some((e) => e.type === "manual_edit")).toBe(true);
    expect(t.postLock.busy()).toEqual([]);
  });

  it("deja superada la simulada publicada, sin borrarla", async () => {
    const t = await scenario();
    const sim = await t.toPublishing(t.publicationOf("x"), { dryRun: true });
    await t.publications.transition(
      sim.id,
      {
        from: "publishing",
        to: "published",
        changes: { externalId: "dry-run:1", publishedAt: NOW },
      },
      { actor: "operator" },
    );
    const { publication, superseded } = await run(t);
    expect(superseded.map((p) => [p.id, p.status])).toEqual([[sim.id, "unpublished"]]);
    expect((await t.publications.get(sim.id))?.dryRun).toBe(true);
    expect(publication.id).not.toBe(sim.id);
    expect(publication.publishedAt).toEqual(NOW);
  });

  it("no duplica si ya hay una real publicada", async () => {
    const t = await scenario();
    await run(t);
    expect(await codeOf(run(t))).toBe("PUBLICATION_ALREADY_CONFIRMED");
  });

  it("rechaza un enlace que no es de la red, una fecha futura, y un texto que no existe", async () => {
    const t = await scenario();
    expect(await codeOf(run(t, { url: "https://example.com/algo" }))).toBe("PUBLISHED_URL_INVALID");
    expect(await codeOf(run(t, { publishedAt: new Date("2027-01-01T00:00:00Z") }))).toBe(
      "PUBLISHED_AT_INVALID",
    );
    expect(await codeOf(run(t, { language: "en" }))).toBe("CONTENT_NOT_FOUND");
  });

  it("no pisa una publicación en curso", async () => {
    const t = await scenario();
    await t.toPublishing(t.publicationOf("x"));
    expect(await codeOf(run(t))).toBe("PUBLICATION_IN_PROGRESS");
  });
});
