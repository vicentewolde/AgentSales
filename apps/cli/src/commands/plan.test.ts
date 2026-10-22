import { randomUUID } from "node:crypto";
import {
  ALL_SCOPE,
  AppError,
  editorialProfileView,
  type LLMProvider,
  runPlan,
  samplePlanResponse,
} from "@agentsales/core";
import { createInMemoryJobQueue } from "@agentsales/core/testing";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, fakeClock, harness } from "../../test/harness.js";
import { register, runPlanList, runPlanRequest, runPlanShow } from "./plan.js";
import { runPostAccept, runPostDiscard, runPostEdit } from "./post.js";

// F9-T21 (spec F9 §4.9 y §4.10): `agentsales plan …` y `post accept|discard` contra la API real en
// proceso; el "worker" corre el plan con el plan de ejemplo (`fake`): nunca la IA real.

/** El proveedor `fake` del worker: el plan de ejemplo armado con el prompt. */
const sampleLlm: LLMProvider = {
  name: "fake",
  async generateStructured(request) {
    return { data: samplePlanResponse(request.prompt), model: "fake" };
  },
};

async function setup() {
  // La cola de la API: `failQueue` la deja caída (QUEUE_UNAVAILABLE) para lo que se encole después.
  let queueDown = false;
  const queue = createInMemoryJobQueue({
    fail: () =>
      queueDown
        ? new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true })
        : undefined,
  });
  const h = Object.assign(harness({ deps: { queue } }), { queue });
  const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  await h.editorialProfiles.upsert(brand.id, {
    ...editorialProfileView(brand.id, null),
    pillars: [{ key: "producto", name: "Producto", description: "Lo que hacemos", weight: 1 }],
    cadence: {
      linkedin: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
      x: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
    },
  });
  /** El fallo con que termina el próximo plan (por defecto, ninguno: corre el de ejemplo). */
  let failWith: { code: string; message: string } | null = null;
  /** Con `draftOnWait`, el worker también redacta: cada corrida de textos activa termina bien. */
  let draftOnWait = false;
  // El worker: en cada espera, el plan en cola corre (o falla con lo pedido).
  const clock = fakeClock(async () => {
    if (draftOnWait) {
      for (const post of await h.posts.list({ brokerId: brand.id }, ALL_SCOPE)) {
        const run = await h.contentRuns.findActive({ kind: "post", id: post.id });
        if (run === null) continue;
        await h.contentRuns.markRunning(run.id);
        await h.contentRuns.markSucceeded(run.id, {
          report: { warnings: [] },
          contents: [
            {
              platform: "linkedin",
              language: "es",
              title: null,
              body: "Texto para LinkedIn",
              hashtags: [],
              llmProvider: "fake",
              llmModel: "fake",
              promptVersion: "social-v1",
              rawOutput: null,
            },
          ],
        });
      }
    }
    for (const run of await h.planRuns.listQueued()) {
      if (failWith !== null) {
        await h.planRuns.markRunning(run.id);
        await h.planRuns.markFailed(run.id, failWith);
        continue;
      }
      await runPlan(
        {
          planRuns: h.planRuns,
          posts: h.posts,
          brokers: h.brokers,
          editorialProfiles: h.editorialProfiles,
          contentRuns: h.contentRuns,
          llm: sampleLlm,
          newId: randomUUID,
        },
        { planRunId: run.id, isLastAttempt: true },
      );
    }
  });
  const deps = () => ({ ...h.io, client: h.client, sleep: clock.sleep, now: clock.now });
  const postDeps = () => ({
    ...deps(),
    cwd: process.cwd(),
    confirm: async () => false,
    stdinIsTty: () => true,
    readStdin: async () => "",
  });
  const ideasOf = async () =>
    (await h.posts.list({ brokerId: brand.id }, ALL_SCOPE)).filter((post) => post.source === "ai");
  return {
    h,
    brand,
    deps,
    postDeps,
    ideasOf,
    failNext: (error: { code: string; message: string }) => {
      failWith = error;
    },
    failQueue: () => {
      queueDown = true;
    },
    draftOnWait: () => {
      draftOnWait = true;
    },
  };
}

describe("agentsales plan", () => {
  it("pide el plan, lo espera e imprime las ideas por semana con el comando de cada una", async () => {
    const s = await setup();
    expect(
      await runPlanRequest(s.deps(), {
        broker: "agentpey",
        days: "14",
        platform: ["linkedin,x"],
        count: "4",
      }),
    ).toBe(0);
    expect(s.h.requests).toContain("POST /plans");
    expect(s.h.queue.jobs.map((job) => job.name)).toEqual(["content.plan"]);
    const ideas = await s.ideasOf();
    expect(ideas).toHaveLength(4);
    expect(ideas.every((idea) => idea.status === "idea")).toBe(true);
    const text = s.h.text();
    expect(text).toMatch(/Plan [0-9a-f-]{36}.*listo · agentpey · del \d{4}-\d{2}-\d{2} al/);
    expect(text).toMatch(/Semana del \d{2}-\d{2} al \d{2}-\d{2}/);
    for (const idea of ideas) {
      expect(text).toContain(idea.topic);
      expect(text).toContain(`agentsales post accept ${idea.id}`);
      expect(text).toContain(`agentsales post discard ${idea.id}`);
    }
    expect(text).toContain("Una idea no se publica sola");
  });

  it("aceptar una idea la pasa a borrador y encola post.draft; descartarla la archiva", async () => {
    const s = await setup();
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", count: "3" })).toBe(0);
    const [accepted, discarded] = await s.ideasOf();
    if (accepted === undefined || discarded === undefined) throw new Error("faltan ideas");

    s.h.out.length = 0;
    expect(await runPostAccept(s.postDeps(), accepted.id)).toBe(0);
    expect(s.h.text()).toContain(`Idea aceptada: "${accepted.topic}" (borrador)`);
    // Para esperar los textos sugiere `post show` o `accept --wait`, nunca `post draft` (pide otros).
    expect(s.h.text()).toContain(`agentsales post show ${accepted.id}`);
    expect(s.h.text()).toContain("agentsales post accept <id> --wait");
    expect(s.h.text()).not.toContain("post draft");
    expect((await s.h.posts.get(accepted.id))?.status).toBe("draft");
    const job = s.h.queue.jobs.at(-1);
    expect(job?.name).toBe("post.draft");
    const run = await s.h.contentRuns.findActive({ kind: "post", id: accepted.id });
    expect(job?.data).toEqual({ contentRunId: run?.id });

    expect(await runPostDiscard(s.postDeps(), discarded.id)).toBe(0);
    expect(s.h.text()).toContain(`Idea descartada: "${discarded.topic}"`);
    expect((await s.h.posts.get(discarded.id))?.status).toBe("archived");

    // Lo que ya no es una idea se explica, sin cambiar nada.
    expect(await runPostAccept(s.postDeps(), accepted.id)).toBe(1);
    expect(s.h.errors()).toContain("POST_NOT_IDEA");
    expect(s.h.errors()).toContain(`agentsales post show ${accepted.id}`);
    expect(s.h.errors()).toContain(
      `Si quedó aceptada sin textos y sin redacción en curso, pídelos con agentsales post draft ${accepted.id}`,
    );
    expect(await runPostDiscard(s.postDeps(), accepted.id)).toBe(1);
    expect((await s.h.posts.get(accepted.id))?.status).toBe("draft");

    // `plan show` muestra a cada una con su estado y lo que sigue.
    const [plan] = await s.h.planRuns.listByBroker(s.brand.id);
    s.h.out.length = 0;
    expect(await runPlanShow(s.deps(), plan?.id ?? "")).toBe(0);
    expect(s.h.text()).toContain(
      `La IA está redactando sus textos: míralos cuando terminen con agentsales post show ${accepted.id}`,
    );
    expect(s.h.text()).toContain("(archivado)");
  });

  it("accept --wait espera la corrida que acaba de crear, sin pedir otra, y muestra la revisión", async () => {
    const s = await setup();
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", count: "1" })).toBe(0);
    const [idea] = await s.ideasOf();
    if (idea === undefined) throw new Error("sin idea");
    s.draftOnWait();
    s.h.out.length = 0;
    s.h.requests.length = 0;
    expect(await runPostAccept(s.postDeps(), idea.id, { wait: true })).toBe(0);
    const text = s.h.text();
    expect(text).toContain(`Idea aceptada: "${idea.topic}" (borrador)`);
    expect(text).toContain("Revisión");
    expect(text).toContain(`agentsales post approve ${idea.id}`);
    expect(text).not.toContain("post draft");
    // Una sola corrida y un solo post.draft: esperar no redacta de nuevo.
    expect(s.h.requests.filter((request) => request.endsWith("/draft"))).toEqual([]);
    expect(s.h.queue.jobs.filter((job) => job.name === "post.draft")).toHaveLength(1);
    expect(await s.h.contentRuns.findActive({ kind: "post", id: idea.id })).toBeNull();
  });

  it("aceptar con la cola caída: la idea queda aceptada y el consejo dice arrancar el worker y pedir los textos", async () => {
    const s = await setup();
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", count: "1" })).toBe(0);
    const [idea] = await s.ideasOf();
    if (idea === undefined) throw new Error("sin idea");
    s.failQueue();
    expect(await runPostAccept(s.postDeps(), idea.id)).toBe(1);
    expect(s.h.errors()).toContain("QUEUE_UNAVAILABLE");
    expect(s.h.errors()).toContain("arranca el worker");
    expect(s.h.errors()).toContain("agentsales post draft");
    expect((await s.h.posts.get(idea.id))?.status).toBe("draft");
  });

  it("editar una idea antes de aceptarla: redes, fecha y brief", async () => {
    const s = await setup();
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", count: "1" })).toBe(0);
    const [idea] = await s.ideasOf();
    if (idea === undefined) throw new Error("sin idea");
    expect(
      await runPostEdit(s.postDeps(), idea.id, {
        platforms: "x",
        date: "2026-11-05 10:00",
        brief: "Lo que yo sé",
      }),
    ).toBe(0);
    expect(s.h.text()).toContain(`agentsales post accept ${idea.id}`);
    expect(await s.h.posts.get(idea.id)).toMatchObject({
      status: "idea",
      platforms: ["x"],
      plannedAt: new Date("2026-11-05T13:00:00Z"),
      brief: "Lo que yo sé",
      briefOrigin: "operator",
    });
  });

  it("un plan que falla dice el motivo y qué hacer (el tope de IA) y sale con 1", async () => {
    const s = await setup();
    s.failNext({ code: "LLM_BUDGET_EXCEEDED", message: "La marca llegó a su tope de IA del mes" });
    expect(await runPlanRequest(s.deps(), { broker: "agentpey" })).toBe(1);
    expect(s.h.text()).toContain("LLM_BUDGET_EXCEEDED: La marca llegó a su tope de IA del mes");
    expect(s.h.text()).toContain("agentsales usage");
    expect(await s.ideasOf()).toEqual([]);
  });

  it("--no-wait imprime el id; list y show lo encuentran; un id que no es uuid se explica", async () => {
    const s = await setup();
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", wait: false })).toBe(0);
    const [plan] = await s.h.planRuns.listByBroker(s.brand.id);
    expect(s.h.out).toEqual([plan?.id]);
    expect(s.h.errors()).toContain(`agentsales plan show ${plan?.id}`);

    s.h.out.length = 0;
    expect(await runPlanList(s.deps(), { broker: "agentpey" })).toBe(0);
    expect(s.h.text()).toContain(plan?.id ?? "?");
    expect(s.h.text()).toContain("en cola");
    expect(await runPlanShow(s.deps(), plan?.id ?? "")).toBe(0);
    expect(s.h.text()).toContain("Todavía no termina");
    expect(await runPlanShow(s.deps(), "no-es-un-id")).toBe(1);
    expect(s.h.errors()).toContain("PLAN_ID_INVALID");
  });

  it("opciones que no sirven se explican sin llamar; con dos marcas hay que decir cuál", async () => {
    const s = await setup();
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", days: "dos" })).toBe(1);
    expect(s.h.errors()).toContain("--days debe ser un número entero");
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", platform: ["portal"] })).toBe(1);
    expect(s.h.errors()).toContain("--platform debe ser");
    expect(await runPlanRequest(s.deps(), {})).toBe(1);
    expect(s.h.errors()).toContain("BROKER_REQUIRED");
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", days: "40" })).toBe(1);
    expect(s.h.errors()).toContain("PLAN_RUN_INVALID");
    expect(s.h.queue.jobs).toEqual([]);
  });

  it("el comando se registra con show y list", async () => {
    const s = await setup();
    const program = new Command().exitOverride();
    register(program, {
      ...s.h.io,
      api: () => s.h.client,
    } as unknown as Parameters<typeof register>[1]);
    const plan = program.commands.find((command) => command.name() === "plan");
    expect(plan?.commands.map((command) => command.name())).toEqual(["show", "list"]);
    expect(plan?.options.map((option) => option.long)).toEqual([
      "--broker",
      "--days",
      "--platform",
      "--count",
      "--start",
      "--brief",
      "--no-wait",
    ]);
  });

  it("--brief manda el pedido del operador: se guarda, la idea de ejemplo lo refleja y show lo muestra (F9.5-T23)", async () => {
    const s = await setup();
    expect(
      await runPlanRequest(s.deps(), {
        broker: "agentpey",
        count: "2",
        brief: "solo ideas para principiantes",
      }),
    ).toBe(0);
    const [plan] = await s.h.planRuns.listByBroker(s.brand.id);
    expect(plan?.request).toMatchObject({ brief: "solo ideas para principiantes" });
    expect((await s.ideasOf()).map((idea) => idea.topic)).toContain(
      "Según tu pedido: solo ideas para principiantes",
    );
    expect(s.h.text()).toContain("Pedido: solo ideas para principiantes");
    // El perfil tiene temas: no avisa que está vacío.
    expect(s.h.errors()).not.toContain("Tu perfil está vacío");
    s.h.out.length = 0;
    expect(await runPlanShow(s.deps(), plan?.id ?? "")).toBe(0);
    expect(s.h.text()).toContain("Pedido: solo ideas para principiantes");
    // Más de 500 caracteres: el error de la API con lo que se puede pedir.
    expect(
      await runPlanRequest(s.deps(), { broker: "agentpey", brief: "a".repeat(501), wait: false }),
    ).toBe(1);
    expect(s.h.errors()).toContain("PLAN_RUN_INVALID");
    expect(s.h.errors()).toContain("el pedido (--brief) hasta 500 caracteres");
  });

  it("con el perfil vacío (sin temas ni hechos), avisa antes de pedir y sugiere brand edit (F9.5-T23)", async () => {
    const s = await setup();
    await s.h.editorialProfiles.upsert(s.brand.id, {
      ...editorialProfileView(s.brand.id, null),
      cadence: { linkedin: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 } },
    });
    expect(await runPlanRequest(s.deps(), { broker: "agentpey", count: "1", wait: false })).toBe(0);
    expect(s.h.errors()).toContain("Tu perfil está vacío: las ideas saldrán genéricas");
    expect(s.h.errors()).toContain("agentsales brand edit --broker agentpey");
    // Solo avisa: el plan se pide igual.
    expect(s.h.queue.jobs.map((job) => job.name)).toEqual(["content.plan"]);
  });

  describe("--broker de plan list por commander (ensayo de la demo de F9)", () => {
    afterEach(() => {
      process.exitCode = undefined;
    });

    it.each([
      [["plan", "list", "--broker", "agentpey"]],
      [["plan", "--broker", "agentpey", "list"]],
    ])("%j llega a la lista, antes o después de list", async (argv) => {
      const s = await setup();
      expect(await runPlanRequest(s.deps(), { broker: "agentpey", wait: false })).toBe(0);
      const [plan] = await s.h.planRuns.listByBroker(s.brand.id);
      const program = new Command().exitOverride();
      register(program, {
        ...s.h.io,
        api: () => s.h.client,
      } as unknown as Parameters<typeof register>[1]);
      s.h.out.length = 0;
      await program.parseAsync(argv, { from: "user" });
      expect(s.h.errors()).not.toContain("BROKER_REQUIRED");
      expect(process.exitCode).toBe(0);
      expect(s.h.text()).toContain(plan?.id ?? "?");
    });
  });
});
