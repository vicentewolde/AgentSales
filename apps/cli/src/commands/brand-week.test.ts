import { chileDateOf, parseChileTime } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { runBrandReady, runPostApproveWeek } from "./brand-week.js";

// F9.5-T27: `agentsales post approve-week` y `agentsales brand ready`, contra la API en proceso.
// Nada publica en el momento: aprobar la semana solo programa, y en vivo pregunta antes.

/** Un día de la semana que viene (hora de Chile). */
const DAY = chileDateOf(new Date(Date.now() + 8 * 86_400_000));

async function setup(options: { publishMode?: "dry-run" | "live"; liveBrand?: boolean } = {}) {
  const h = harness(
    options.publishMode === undefined ? {} : { deps: { publishMode: options.publishMode } },
  );
  const brand = await h.brokers.create(
    { ...brokerData("agentpey"), brandName: "AgentPey" },
    { kind: "brand" },
  );
  // ADR-0036: en vivo solo una marca propia y encendida.
  if (options.liveBrand === true) {
    await h.brokers.setSettings(brand.id, { operatorOwned: true });
    await h.brokers.setLiveEnabled(brand.id, true);
  }
  await h.platformAccounts.upsertConnected({
    brokerId: brand.id,
    platform: "linkedin",
    externalAccountId: "perfil-1",
    displayName: "Vinny",
    tokenExpiresAt: null,
    meta: { mode: "manual" },
    credentials: { accessToken: "token-de-prueba" },
  });
  const addPost = async (topic: string, texts: { platform: "linkedin" | "x"; body?: string }[]) => {
    const post = await h.posts.create({
      brokerId: brand.id,
      topic,
      kind: "text",
      status: "draft",
      plannedAt: parseChileTime(`${DAY} 10:00`),
    });
    const run = await h.contentRuns.create({ postId: post.id, texts: true });
    await h.contentRuns.markRunning(run.id);
    await h.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: texts.map((text) => ({
        platform: text.platform,
        language: "es",
        title: null,
        body: text.body ?? `Texto para ${text.platform}`,
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "social-v1",
        rawOutput: null,
      })),
    });
    return post;
  };
  const answers: boolean[] = [];
  const questions: string[] = [];
  const deps = {
    ...h.io,
    client: h.client,
    confirm: async (question: string) => {
      questions.push(question);
      return answers.shift() ?? false;
    },
  };
  const statuses = async (postId: string) =>
    (await h.publications.listBySubject({ kind: "post", id: postId })).map((p) => [
      p.platform,
      p.status,
      p.dryRun,
    ]);
  return { h, brand, addPost, deps, answers, questions, statuses };
}

describe("post approve-week", () => {
  it("muestra la semana, aprueba y programa cada post a su fecha y dice lo que no pudo", async () => {
    const s = await setup();
    const good = await s.addPost("Lo que aprendí", [{ platform: "linkedin" }]);
    const bad = await s.addPost("Sin cuenta de X", [{ platform: "x" }]);
    const code = await runPostApproveWeek(s.deps, { broker: "agentpey", start: DAY });
    expect(code).toBe(1);
    const text = s.h.text();
    expect(text).toContain("AgentPey · Semana del");
    expect(text).toContain("Lo que aprendí: LinkedIn (es)");
    expect(text).toContain(`✓ LinkedIn: programado para ${DAY} 10:00 (simulación)`);
    expect(text).toContain("– X: Sin cuenta conectada (ACCOUNT_NOT_CONNECTED");
    expect(text).toContain("→ Conéctala en Cuentas");
    // En simulación no pregunta, y nada sale ahora.
    expect(s.questions).toEqual([]);
    expect(await s.statuses(good.id)).toEqual([["linkedin", "scheduled", true]]);
    expect(await s.statuses(bad.id)).toEqual([]);
    // Repetirla no pisa lo programado: lo dice y sigue igual.
    await runPostApproveWeek(s.deps, { broker: "agentpey", start: DAY });
    expect(s.h.text()).toContain(`= LinkedIn: Ya está programado para el ${DAY} 10:00`);
    expect(await s.statuses(good.id)).toEqual([["linkedin", "scheduled", true]]);
  });

  it("sin ideas aceptadas lo dice y sale bien, sin aprobar nada", async () => {
    const s = await setup();
    expect(await runPostApproveWeek(s.deps, { broker: "agentpey", start: DAY })).toBe(0);
    expect(s.h.text()).toContain("No hay ideas aceptadas esa semana");
    expect(s.h.requests).not.toContain(`POST /brokers/${s.brand.id}/week/approve`);
  });

  it("con el servidor en vivo y la marca apagada, programa en simulación sin preguntar", async () => {
    const s = await setup({ publishMode: "live" });
    const post = await s.addPost("Marca apagada", [{ platform: "linkedin" }]);
    expect(await runPostApproveWeek(s.deps, { broker: "agentpey", start: DAY })).toBe(0);
    expect(s.questions).toEqual([]);
    expect(await s.statuses(post.id)).toEqual([["linkedin", "scheduled", true]]);
  });

  it("en vivo (servidor y marca) pregunta antes: sin confirmar no programa; con --yes, en vivo", async () => {
    const s = await setup({ publishMode: "live", liveBrand: true });
    const post = await s.addPost("En vivo", [{ platform: "linkedin" }]);
    expect(await runPostApproveWeek(s.deps, { broker: "agentpey", start: DAY })).toBe(1);
    expect(s.questions).toHaveLength(1);
    expect(await s.statuses(post.id)).toEqual([]);
    expect(await runPostApproveWeek(s.deps, { broker: "agentpey", start: DAY, yes: true })).toBe(0);
    expect(await s.statuses(post.id)).toEqual([["linkedin", "scheduled", false]]);
    expect(s.h.text()).toContain("Programado EN VIVO");
  });

  it("un --start mal escrito se frena antes de llamar a la API", async () => {
    const s = await setup();
    expect(await runPostApproveWeek(s.deps, { broker: "agentpey", start: "lunes" })).toBe(1);
    expect(s.h.errors()).toContain("--start debe ser un día");
    expect(s.h.requests).toEqual([]);
  });
});

describe("brand ready", () => {
  it("imprime la lista con lo de la marca y cada red, con qué falta y el comando", async () => {
    const s = await setup();
    expect(await runBrandReady(s.deps, { broker: "agentpey" })).toBe(0);
    const text = s.h.text();
    expect(text).toContain("AgentPey (agentpey):");
    expect(text).toContain("✗ Modo de la marca: Simulación");
    expect(text).toContain("LinkedIn ✓");
    expect(text).toContain("✓ Cuenta conectada: Conectada: Vinny.");
    expect(text).toContain("· LinkedIn a mano: A mano");
  });

  it("--json da la lista tal cual", async () => {
    const s = await setup();
    expect(await runBrandReady(s.deps, { broker: "agentpey", json: true })).toBe(0);
    const parsed = JSON.parse(s.h.text()) as { slug: string; networks: { platform: string }[] };
    expect(parsed.slug).toBe("agentpey");
    expect(parsed.networks.map((network) => network.platform)).toEqual(["linkedin"]);
  });
});
