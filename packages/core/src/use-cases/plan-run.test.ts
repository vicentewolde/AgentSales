import { describe, expect, it } from "vitest";
import { editorialProfileView } from "../editorial-profile.js";
import { AppError, isAppError } from "../errors.js";
import { monthlySpend } from "../llm-budget.js";
import type { LlmTokenUsage } from "../llm-usage.js";
import type { NewListing } from "../ports/listing-repository.js";
import type { LLMProvider, LLMRequest } from "../ports/llm-provider.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import { planRunReportSchema } from "../social/plan.js";
import { PLAN_PROMPT_VERSION } from "../social/plan-prompt.js";
import { samplePlanResponse } from "../social/plan-sample.js";
import { postSubject } from "../subject.js";
import {
  contentBrokerFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaRepository,
  createInMemoryPlanRunRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "../testing/index.js";
import { draftPost } from "./draft-post.js";
import { acceptIdea, discardIdea } from "./plan-ideas.js";
import { updatePost } from "./posts.js";
import { getPlanRun, listPlanRuns, requestPlanRun } from "./request-plan-run.js";
import { runPlan } from "./run-plan.js";

// El plan de ideas de punta a punta en core (F9-T20, spec F9 §4.9, ADR-0030): pedirlo, correrlo
// (el job `content.plan`), y aceptar o descartar sus ideas. Con el plan de ejemplo (`fake`) o
// respuestas guionadas: nunca la IA real.

// Martes 20 de octubre de 2026, 12:00 en Chile.
const NOW = new Date("2026-10-20T15:00:00Z");

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);

const SPEND: LlmTokenUsage = {
  inputTokens: 4000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 2000,
  requestId: "req_plan",
};

const ADMIN = {
  id: "00000000-0000-4000-8000-0000000000a1",
  role: "admin" as const,
  brokerId: null,
};

/** El proveedor `fake` del worker: el plan de ejemplo armado con el prompt. */
function samplePlanProvider(): LLMProvider & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    name: "fake",
    requests,
    async generateStructured(request) {
      requests.push(request);
      return { data: samplePlanResponse(request.prompt), model: "fake" };
    },
  };
}

/**
 * Una idea como la entrega la IA, sin fecha ni hora (ADR-0034): el código la agenda en la cadencia
 * de LinkedIn (martes y jueves a las 09:00).
 */
const idea = (tema: string, overrides: Record<string, unknown> = {}) => ({
  tema,
  linea: "producto",
  redes: ["linkedin"],
  formato: "text",
  porque: "La línea Producto pesa más.",
  ...overrides,
});

type Setup = {
  /** Respuestas guionadas del proveedor del operador; sin ellas, el plan de ejemplo. */
  llm?: ScriptedLlmResponse[];
  /** Respuestas de la API (marca de un tercero: `operatorOwned = false`). */
  apiLlm?: ScriptedLlmResponse[];
  capUsd?: number | null;
  autoPublish?: boolean;
  queueFails?: boolean;
};

async function setup(options: Setup = {}) {
  const usesApi = options.apiLlm !== undefined;
  const broker = contentBrokerFixture({
    kind: "brand",
    brandName: "AgentPey",
    slug: "agentpey",
    operatorOwned: !usesApi,
    llmMonthlyCapUsd: options.capUsd ?? null,
    autoPublish: options.autoPublish ?? false,
    fixedHashtags: [],
  });
  const other = contentBrokerFixture({
    id: "00000000-0000-4000-8000-0000000000b2",
    slug: "otra",
    brandName: "Otra",
  });
  const brokers = createInMemoryBrokerRepository([broker, other]);
  const posts = createInMemoryPostRepository();
  const planRuns = createInMemoryPlanRunRepository({ posts });
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  await editorialProfiles.upsert(broker.id, {
    ...editorialProfileView(broker.id, null),
    languages: ["es"],
    pillars: [
      { key: "producto", name: "Producto", description: "Lo que construimos", weight: 2 },
      { key: "bastidores", name: "Bastidores", description: "Cómo trabajamos", weight: 1 },
    ],
    facts: ["AgentPey publica en LinkedIn y X"],
    cadence: {
      linkedin: { postsPerWeek: 2, days: ["tue", "thu"], hours: ["09:00"], languageGapHours: 6 },
      x: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
    },
  });
  const media = createInMemoryMediaRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const { contents, contentRuns } = createInMemoryContentRepositories({
    brokerOfPost: async (postId) => (await posts.get(postId))?.brokerId ?? null,
    planRuns: () => planRuns.all(),
  });
  const publications = createInMemoryPublicationRepository();
  const repos: PostLockedRepositories = {
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  };
  const postLock = createInMemoryPostLock(repos);
  const listings = createInMemoryListingRepository();
  // Lo que nunca va a la IA del plan: las notas internas de un aviso de la marca y el brief de un
  // post (el plan ve solo los temas).
  await listings.create({
    ...(contentListingFixture({
      brokerId: broker.id,
      internalNotes: "NOTA INTERNA: el dueño debe dos meses",
    }) as unknown as NewListing),
    externalRef: "P-NOTAS",
    sourceHash: "x",
  });
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  });
  const queue = createInMemoryJobQueue({
    fail: () =>
      options.queueFails
        ? new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true })
        : undefined,
  });
  // Con `apiLlm`, el del operador no es `fake` (con `fake`, todas las marcas lo usan).
  const llm =
    options.llm !== undefined || usesApi
      ? createInMemoryLlmProvider(options.llm ?? [], "claude-cli")
      : samplePlanProvider();
  const apiLlm = usesApi ? createInMemoryLlmProvider(options.apiLlm ?? [], "anthropic-api") : null;
  let ids = 0;
  const runDeps = {
    planRuns,
    posts,
    brokers,
    editorialProfiles,
    contentRuns,
    llm,
    apiLlm,
    newId: () => `00000000-0000-4000-8000-1${String(++ids).padStart(11, "0")}`,
    clock: () => NOW,
  };
  const requestDeps = {
    brokers,
    editorialProfiles,
    platformAccounts,
    planRuns,
    contentRuns,
    queue,
    now: () => NOW,
  };
  const ideaDeps = {
    lock,
    postLock,
    contentRuns,
    queue,
    posts,
    brokers,
    now: () => NOW,
  };
  /** Pide un plan y lo corre (el job). */
  const plan = async (input: Parameters<typeof requestPlanRun>[2] = {}) => {
    const { run } = await requestPlanRun(requestDeps, ADMIN, { brokerId: broker.id, ...input });
    const result = await runPlan(runDeps, { planRunId: run.id, isLastAttempt: false });
    return { run, result, saved: await planRuns.get(run.id) };
  };
  return {
    broker,
    other,
    brokers,
    posts,
    planRuns,
    contentRuns,
    contents,
    publications,
    queue,
    llm,
    apiLlm,
    runDeps,
    requestDeps,
    ideaDeps,
    plan,
    postLock,
    editorialProfiles,
    media,
    platformAccounts,
  };
}

const brandUser = (brokerId: string) => ({
  id: "00000000-0000-4000-8000-0000000000a2",
  role: "broker" as const,
  brokerId,
});

describe("requestPlanRun", () => {
  it("por defecto: las próximas 2 semanas, las redes de la marca y las ideas según la cadencia", async () => {
    const t = await setup();
    const { run, reused } = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    expect(reused).toBe(false);
    expect(run).toMatchObject({
      brokerId: t.broker.id,
      status: "queued",
      periodStart: new Date("2026-10-21T03:00:00Z"),
      periodEnd: new Date("2026-11-04T03:00:00Z"),
      // Las redes con cadencia (sin cuentas todavía), y 2 por semana × 2 semanas.
      request: { platforms: ["x", "linkedin"], count: 4, days: 14, requestedBy: ADMIN.id },
    });
    // El job, ya creado el plan, con su id (idempotente con `singletonKey`).
    expect(t.queue.jobs).toEqual([
      { name: "content.plan", data: { planRunId: run.id }, options: { singletonKey: run.id } },
    ]);
  });

  it("con un plan en cola o corriendo, lo devuelve y lo vuelve a encolar", async () => {
    const t = await setup();
    const first = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    const again = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id, days: 7 });
    expect(again).toMatchObject({ reused: true, run: { id: first.run.id } });
    expect(t.queue.jobs).toHaveLength(2);
    expect(t.planRuns.all()).toHaveLength(1);
  });

  it("redes, período y cuántas ideas: lo pedido, o PLAN_RUN_INVALID", async () => {
    const t = await setup();
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, {
      brokerId: t.broker.id,
      platforms: ["LinkedIn"],
      startDay: "2026-11-02",
      days: 7,
      count: 3,
    });
    expect(run.request).toMatchObject({ platforms: ["linkedin"], count: 3, days: 7 });
    expect(run.periodStart).toEqual(new Date("2026-11-02T03:00:00Z"));
    const ask = (input: Parameters<typeof requestPlanRun>[2]) =>
      caught(requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id, ...input }));
    expect(codeOf(await ask({ platforms: ["instagram"] }))).toBe("PLAN_RUN_INVALID");
    expect(codeOf(await ask({ platforms: ["portal_inmobiliario"] }))).toBe("PLAN_RUN_INVALID");
    expect(codeOf(await ask({ count: 21 }))).toBe("PLAN_RUN_INVALID");
    expect(codeOf(await ask({ count: 0 }))).toBe("PLAN_RUN_INVALID");
    expect(codeOf(await ask({ days: 40 }))).toBe("PLAN_RUN_INVALID");
    expect(codeOf(await ask({ startDay: "2026-10-01" }))).toBe("PLAN_RUN_INVALID");
  });

  it("una marca sin redes (ni cuentas ni cadencia) es POST_NO_PLATFORMS", async () => {
    const t = await setup();
    await t.editorialProfiles.upsert(t.broker.id, editorialProfileView(t.broker.id, null));
    expect(
      codeOf(await caught(requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id }))),
    ).toBe("POST_NO_PLATFORMS");
    expect(t.planRuns.all()).toEqual([]);
  });

  it("un corredor pide para su marca; otra no existe para él", async () => {
    const t = await setup();
    const { run } = await requestPlanRun(t.requestDeps, brandUser(t.broker.id), {});
    expect(run.brokerId).toBe(t.broker.id);
    expect(
      codeOf(
        await caught(
          requestPlanRun(t.requestDeps, brandUser(t.broker.id), { brokerId: t.other.id }),
        ),
      ),
    ).toBe("BROKER_NOT_FOUND");
    expect(codeOf(await caught(requestPlanRun(t.requestDeps, ADMIN, {})))).toBe("PLAN_RUN_INVALID");
  });

  it("con la marca en su tope de IA del mes, LLM_BUDGET_EXCEEDED y no crea el plan", async () => {
    const t = await setup({ capUsd: 0 });
    expect(
      codeOf(await caught(requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id }))),
    ).toBe("LLM_BUDGET_EXCEEDED");
    expect(t.planRuns.all()).toEqual([]);
  });

  it("si la cola no está, el plan nuevo queda en failed con ese motivo", async () => {
    const t = await setup({ queueFails: true });
    expect(
      codeOf(await caught(requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id }))),
    ).toBe("QUEUE_UNAVAILABLE");
    expect(t.planRuns.all()).toMatchObject([
      { status: "failed", error: { code: "QUEUE_UNAVAILABLE" } },
    ]);
  });
});

describe("runPlan con el plan de ejemplo (fake)", () => {
  it("un plan de N ideas crea N posts idea de la IA, sin textos ni publicaciones", async () => {
    const t = await setup();
    await t.posts.create({
      brokerId: t.broker.id,
      topic: "Un post del operador",
      kind: "text",
      brief: "BRIEF RESERVADO del operador",
    });
    const { run, result, saved } = await t.plan({ count: 4 });

    expect(result.outcome).toBe("succeeded");
    expect(saved).toMatchObject({ status: "succeeded", promptVersion: PLAN_PROMPT_VERSION });
    const ideas = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    expect(ideas).toHaveLength(4);
    for (const post of ideas) {
      expect(post).toMatchObject({
        brokerId: t.broker.id,
        status: "idea",
        source: "ai",
        briefOrigin: "ai",
        brief: null,
        planRunId: run.id,
        createdBy: ADMIN.id,
      });
      expect(post.plannedAt?.getTime()).toBeGreaterThanOrEqual(run.periodStart.getTime());
      expect(post.plannedAt?.getTime()).toBeLessThan(run.periodEnd.getTime());
      expect(["producto", "bastidores"]).toContain(post.pillar);
      expect(post.rationale).not.toBeNull();
    }
    // Sin textos, corridas de textos ni publicaciones (ADR-0030, punto 2).
    for (const post of ideas) {
      expect(await t.contents.listCurrent(postSubject(post.id))).toEqual([]);
      expect(await t.contentRuns.findActive(postSubject(post.id))).toBeNull();
      expect(await t.publications.listBySubject(postSubject(post.id))).toEqual([]);
    }
    // El reporte: cada idea con el id de su post y sus redes, y la llamada.
    const report = planRunReportSchema.parse(saved?.report);
    expect(report.ideas.map((item) => item.postId).sort()).toEqual(
      ideas.map((post) => post.id).sort(),
    );
    expect(report.discarded).toEqual([]);
    expect(report.llm).toMatchObject({ provider: "fake", model: "fake", attempts: 1 });
    // Cada idea guarda sus redes (las del reporte): al aceptarla se redacta solo para esas.
    for (const item of report.ideas) {
      expect(ideas.find((post) => post.id === item.postId)?.platforms).toEqual(item.platforms);
    }
    // La IA recibió el perfil de su marca y nada de otra; nunca notas internas ni briefs.
    const [request] = (t.llm as ReturnType<typeof samplePlanProvider>).requests;
    expect(request?.prompt).toContain("AgentPey publica en LinkedIn y X");
    expect(request?.prompt).not.toContain("Otra");
    expect(request?.prompt).not.toContain("NOTA INTERNA");
    expect(request?.prompt).not.toContain("debe dos meses");
    expect(request?.prompt).not.toContain("BRIEF RESERVADO");
    // Su tema sí: es un tema reciente que no se repite.
    expect(request?.prompt).toContain("Un post del operador");
  });

  it("un segundo plan no repite los temas del primero ni las ideas descartadas", async () => {
    const t = await setup();
    const first = await t.plan({ count: 4 });
    const firstIdeas = await t.posts.list({ planRunId: first.run.id }, { kind: "all" });
    // Se descarta una (cuenta como descartada); las demás siguen como ideas recientes.
    await discardIdea(t.ideaDeps, ADMIN, firstIdeas[0]?.id ?? "");
    const second = await t.plan({ count: 4, startDay: "2026-11-04" });
    const secondIdeas = await t.posts.list({ planRunId: second.run.id }, { kind: "all" });
    expect(secondIdeas).toHaveLength(4);
    const before = new Set(firstIdeas.map((post) => post.topic.toLowerCase()));
    for (const post of secondIdeas) expect(before.has(post.topic.toLowerCase())).toBe(false);
    // La IA recibió los temas recientes y la idea descartada.
    const prompt = (t.llm as ReturnType<typeof samplePlanProvider>).requests[1]?.prompt ?? "";
    const data = prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1);
    const parsed = JSON.parse(data) as { temas_recientes: string[]; ideas_descartadas: string[] };
    expect(parsed.ideas_descartadas).toEqual([firstIdeas[0]?.topic]);
    expect(parsed.temas_recientes).toHaveLength(3);
  });

  it("auto_publish no se aplica: una idea de una marca con publicación automática no se publica", async () => {
    const t = await setup({ autoPublish: true });
    const { run } = await t.plan({ count: 2 });
    const ideas = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    expect(ideas.every((post) => post.status === "idea")).toBe(true);
    // Solo se encoló el plan: ni textos ni publicaciones.
    expect(t.queue.jobs.map((job) => job.name)).toEqual(["content.plan"]);
    expect(t.publications.all()).toEqual([]);

    // Aceptada y con sus textos, sigue sin publicarse: aprobar y programar son a mano.
    const accepted = await acceptIdea(t.ideaDeps, ADMIN, ideas[0]?.id ?? "");
    const drafted = await draftPost(
      {
        contentRuns: t.contentRuns,
        posts: t.posts,
        brokers: t.brokers,
        editorialProfiles: t.editorialProfiles,
        platformAccounts: t.platformAccounts,
        media: t.media,
        postLock: t.postLock,
        llm: createInMemoryLlmProvider([
          {
            data: {
              texts: [
                { platform: "x", language: "es", body: "Una idea para pensar.", hashtags: [] },
                {
                  platform: "linkedin",
                  language: "es",
                  body: "Una idea para pensar.",
                  hashtags: [],
                },
              ],
              warnings: [],
            },
          },
        ]),
        clock: () => NOW,
      },
      { contentRunId: accepted.run.id, isLastAttempt: false },
    );
    expect(drafted).toMatchObject({ outcome: "succeeded", postStatus: "draft" });
    expect(await t.publications.listBySubject(postSubject(accepted.post.id))).toEqual([]);
    expect(t.queue.jobs.map((job) => job.name)).toEqual(["content.plan", "post.draft"]);
  });
});

describe("runPlan con respuestas guionadas", () => {
  it("el código agenda las ideas en la cadencia (la fecha de la IA se ignora); una que no pasa queda en el reporte", async () => {
    const t = await setup({
      llm: [
        {
          data: {
            ideas: [
              idea("Cómo decidimos qué construir"),
              idea("Solo para TikTok", { redes: ["tiktok"] }),
              // Una fecha fuera del período que mande la IA igual no cuenta (ADR-0034).
              idea("Lo que viene", { linea: "bastidores", fecha: "2026-11-10", hora: "23:00" }),
            ],
            warnings: ["Faltan hechos para proponer mejor"],
          },
        },
      ],
    });
    const { run, saved } = await t.plan({ count: 3 });
    const ideas = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    expect(ideas.map((post) => [post.topic, post.pillar, post.plannedAt?.toISOString()])).toEqual([
      ["Cómo decidimos qué construir", "producto", "2026-10-22T12:00:00.000Z"],
      ["Lo que viene", "bastidores", "2026-10-27T12:00:00.000Z"],
    ]);
    expect(saved?.report).toMatchObject({
      discarded: [{ topic: "Solo para TikTok", code: "PLATFORM_NOT_REQUESTED" }],
      warnings: ["Faltan hechos para proponer mejor"],
    });
  });

  it("un tema de los últimos 60 días se descarta", async () => {
    const t = await setup({
      llm: [{ data: { ideas: [idea("Bastidores de la semana")], warnings: [] } }],
    });
    await t.posts.create({ brokerId: t.broker.id, topic: "Bastidores de la semana", kind: "text" });
    const { saved } = await t.plan({ count: 1 });
    expect(saved).toMatchObject({
      status: "succeeded",
      report: { ideas: [], discarded: [{ code: "REPEATED_TOPIC" }] },
    });
  });

  it("una respuesta que no calza se reintenta una vez; después, failed con LLM_OUTPUT_INVALID", async () => {
    const t = await setup({
      llm: [{ data: { ideas: "no" } }, { data: { ideas: [idea("Una idea")], warnings: [] } }],
    });
    const { saved } = await t.plan({ count: 1 });
    expect(saved?.status).toBe("succeeded");
    expect(saved?.report).toMatchObject({ llm: { attempts: 2 } });

    const bad = await setup({ llm: [{ data: {} }, { data: {} }] });
    const { run } = await requestPlanRun(bad.requestDeps, ADMIN, { brokerId: bad.broker.id });
    expect(
      codeOf(await caught(runPlan(bad.runDeps, { planRunId: run.id, isLastAttempt: false }))),
    ).toBe("LLM_OUTPUT_INVALID");
    expect(await bad.planRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "LLM_OUTPUT_INVALID" },
    });
    expect(bad.posts.all()).toEqual([]);
  });

  it("la IA que no responde: reintentable mientras queden intentos; en el último, failed", async () => {
    const t = await setup({ llm: [{ error: LLM_ERRORS.unavailable() }] });
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    const error = await caught(runPlan(t.runDeps, { planRunId: run.id, isLastAttempt: false }));
    expect(error).toMatchObject({ code: "LLM_UNAVAILABLE", retriable: true });
    expect((await t.planRuns.get(run.id))?.status).toBe("running");

    const last = await setup({ llm: [{ error: LLM_ERRORS.unavailable() }] });
    const lastRun = await requestPlanRun(last.requestDeps, ADMIN, { brokerId: last.broker.id });
    await caught(runPlan(last.runDeps, { planRunId: lastRun.run.id, isLastAttempt: true }));
    expect(await last.planRuns.get(lastRun.run.id)).toMatchObject({
      status: "failed",
      error: { code: "LLM_UNAVAILABLE" },
    });
  });

  it("un plan terminado no se vuelve a correr ni duplica sus ideas", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 2 });
    expect(await runPlan(t.runDeps, { planRunId: run.id, isLastAttempt: false })).toEqual({
      outcome: "skipped",
      status: "succeeded",
    });
    expect(await t.posts.list({ planRunId: run.id }, { kind: "all" })).toHaveLength(2);
    expect(
      codeOf(await caught(runPlan(t.runDeps, { planRunId: "no-existe", isLastAttempt: false }))),
    ).toBe("PLAN_RUN_NOT_FOUND");
  });

  it("con el worker apagándose, relanza reintentable sin cerrar el plan", async () => {
    const t = await setup();
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
    const error = await caught(
      runPlan(t.runDeps, { planRunId: run.id, isLastAttempt: true, signal }),
    );
    expect(error).toMatchObject({ code: "PLAN_RUN_ABORTED", retriable: true });
    expect((await t.planRuns.get(run.id))?.status).toBe("running");
  });
});

describe("el gasto del plan", () => {
  it("se anota por marca, entra a sumLlmCost y se anota también si falla después de llamar", async () => {
    const t = await setup({
      apiLlm: [
        {
          data: { ideas: [idea("Una idea")], warnings: [] },
          model: "claude-sonnet-5-5",
          usage: SPEND,
        },
      ],
    });
    const { saved } = await t.plan({ count: 1 });
    expect(saved?.llmUsage?.costUsd).toBeGreaterThan(0);
    const [spend] = await monthlySpend(
      { contentRuns: t.contentRuns, brokers: t.brokers },
      { month: "2026-10", scope: { kind: "broker", brokerId: t.broker.id } },
    );
    expect(spend).toMatchObject({ brokerId: t.broker.id, runs: 1 });
    expect(spend?.spentUsd).toBeCloseTo(saved?.llmUsage?.costUsd ?? 0, 6);

    // Dos respuestas que no calzan, cobradas: el plan falla con el gasto anotado.
    const failing = await setup({
      apiLlm: [
        { data: {}, model: "claude-sonnet-5-5", usage: SPEND },
        { data: {}, model: "claude-sonnet-5-5", usage: { ...SPEND, requestId: "req_2" } },
      ],
    });
    const { run } = await requestPlanRun(failing.requestDeps, ADMIN, {
      brokerId: failing.broker.id,
    });
    await caught(runPlan(failing.runDeps, { planRunId: run.id, isLastAttempt: false }));
    const failed = await failing.planRuns.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.llmUsage?.calls).toBe(2);
  });

  it("respeta el tope: alcanzado entre el pedido y la corrida, no llama a la IA y falla", async () => {
    const t = await setup({ apiLlm: [], capUsd: 0.01 });
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    // Los textos de un post de la marca gastaron entre medio (un plan activo por marca, así que
    // el gasto viene de otra corrida).
    const post = await t.posts.create({ brokerId: t.broker.id, topic: "Otro", kind: "text" });
    const spent = await t.contentRuns.create({ postId: post.id, texts: true });
    await t.contentRuns.addLlmUsage(spent.id, {
      provider: "anthropic-api",
      model: "claude-sonnet-5-5",
      inputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1,
      costUsd: 0.02,
      priceTable: "2026-10-16",
      requestId: "req_x",
    });
    expect(
      codeOf(await caught(runPlan(t.runDeps, { planRunId: run.id, isLastAttempt: false }))),
    ).toBe("LLM_BUDGET_EXCEEDED");
    expect(await t.planRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "LLM_BUDGET_EXCEEDED" },
      llmUsage: null,
    });
    expect(t.apiLlm?.requests).toEqual([]);
  });
});

describe("aceptar, descartar y editar ideas", () => {
  it("aceptar: la idea pasa a draft, se crea su corrida de textos y se encola post.draft", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    const accepted = await acceptIdea(t.ideaDeps, ADMIN, ideaPost?.id ?? "");
    expect(accepted.post).toMatchObject({ id: ideaPost?.id, status: "draft", source: "ai" });
    expect(accepted.reused).toBe(false);
    expect(accepted.run).toMatchObject({
      subject: postSubject(ideaPost?.id ?? ""),
      status: "queued",
    });
    expect(t.queue.jobs.at(-1)).toEqual({
      name: "post.draft",
      data: { contentRunId: accepted.run.id },
      options: { singletonKey: accepted.run.id },
    });
  });

  it("descartar: la idea pasa a archived, sin textos ni corrida", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    const discarded = await discardIdea(t.ideaDeps, ADMIN, ideaPost?.id ?? "");
    expect(discarded.status).toBe("archived");
    expect(await t.contentRuns.findActive(postSubject(ideaPost?.id ?? ""))).toBeNull();
  });

  it("solo una idea se acepta o se descarta: lo demás es POST_NOT_IDEA, sin cambiar nada", async () => {
    const t = await setup();
    const manual = await t.posts.create({ brokerId: t.broker.id, topic: "Manual", kind: "text" });
    expect(codeOf(await caught(acceptIdea(t.ideaDeps, ADMIN, manual.id)))).toBe("POST_NOT_IDEA");
    expect(codeOf(await caught(discardIdea(t.ideaDeps, ADMIN, manual.id)))).toBe("POST_NOT_IDEA");
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    await discardIdea(t.ideaDeps, ADMIN, ideaPost?.id ?? "");
    expect(codeOf(await caught(acceptIdea(t.ideaDeps, ADMIN, ideaPost?.id ?? "")))).toBe(
      "POST_NOT_IDEA",
    );
    expect(t.queue.jobs.map((job) => job.name)).toEqual(["content.plan"]);
  });

  it("lo de otra marca no existe; con el tope alcanzado, aceptar no cambia nada", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    const outsider = brandUser(t.other.id);
    expect(codeOf(await caught(acceptIdea(t.ideaDeps, outsider, ideaPost?.id ?? "")))).toBe(
      "POST_NOT_FOUND",
    );
    expect(codeOf(await caught(discardIdea(t.ideaDeps, outsider, ideaPost?.id ?? "")))).toBe(
      "POST_NOT_FOUND",
    );
    await t.brokers.setSettings(t.broker.id, { llmMonthlyCapUsd: 0 });
    expect(codeOf(await caught(acceptIdea(t.ideaDeps, ADMIN, ideaPost?.id ?? "")))).toBe(
      "LLM_BUDGET_EXCEEDED",
    );
    expect((await t.posts.get(ideaPost?.id ?? ""))?.status).toBe("idea");
  });

  it("editar una idea (updatePost): el brief pasa a ser del operador y la fecha se mueve", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    const edited = await updatePost(
      { posts: t.posts, postLock: t.postLock, editorialProfiles: t.editorialProfiles },
      ADMIN,
      ideaPost?.id ?? "",
      { brief: "Contar cómo elegimos las redes", plannedAt: new Date("2026-10-29T12:00:00Z") },
    );
    expect(edited).toMatchObject({
      status: "idea",
      brief: "Contar cómo elegimos las redes",
      briefOrigin: "operator",
      plannedAt: new Date("2026-10-29T12:00:00Z"),
    });
  });

  it("getPlanRun: el plan con su reporte y sus ideas, solo dentro del alcance", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 2 });
    const view = await getPlanRun({ planRuns: t.planRuns, posts: t.posts }, ADMIN, run.id);
    expect(view.run.status).toBe("succeeded");
    expect(view.report?.ideas).toHaveLength(2);
    expect(view.ideas.map((post) => post.status)).toEqual(["idea", "idea"]);
    expect(
      codeOf(
        await caught(
          getPlanRun({ planRuns: t.planRuns, posts: t.posts }, brandUser(t.other.id), run.id),
        ),
      ),
    ).toBe("PLAN_RUN_NOT_FOUND");
  });
});

describe("las redes de una idea aceptada (decisión del operador, F9-T20)", () => {
  it("al aceptar, se redacta solo para las redes que la IA sugirió para esa idea", async () => {
    const t = await setup({
      llm: [
        {
          data: {
            ideas: [idea("Solo para X", { redes: ["x"] })],
            warnings: [],
          },
        },
      ],
    });
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    expect(ideaPost?.platforms).toEqual(["x"]);
    const accepted = await acceptIdea(t.ideaDeps, ADMIN, ideaPost?.id ?? "");
    const draftLlm = createInMemoryLlmProvider([
      {
        data: {
          texts: [
            { platform: "x", language: "es", body: "Una idea para pensar.", hashtags: [] },
            { platform: "linkedin", language: "es", body: "Una idea para pensar.", hashtags: [] },
          ],
          warnings: [],
        },
      },
    ]);
    await draftPost(
      {
        contentRuns: t.contentRuns,
        posts: t.posts,
        brokers: t.brokers,
        editorialProfiles: t.editorialProfiles,
        platformAccounts: t.platformAccounts,
        media: t.media,
        postLock: t.postLock,
        llm: draftLlm,
        clock: () => NOW,
      },
      { contentRunId: accepted.run.id, isLastAttempt: false },
    );
    const texts = await t.contents.listCurrent(postSubject(ideaPost?.id ?? ""));
    expect(texts.map((item) => item.platform)).toEqual(["x"]);
    // La IA de los textos recibió solo X.
    expect(draftLlm.requests[0]?.prompt).toContain('"platform": "x"');
    expect(draftLlm.requests[0]?.prompt).not.toContain('"platform": "linkedin"');
  });

  it("updatePost cambia las redes de una idea; una red que no publica posts es POST_INVALID", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 1 });
    const [ideaPost] = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    const deps = { posts: t.posts, postLock: t.postLock, editorialProfiles: t.editorialProfiles };
    const edited = await updatePost(deps, ADMIN, ideaPost?.id ?? "", {
      platforms: ["LinkedIn", "x", "x"],
    });
    expect(edited.platforms).toEqual(["x", "linkedin"]);
    expect(
      (await updatePost(deps, ADMIN, ideaPost?.id ?? "", { platforms: null })).platforms,
    ).toBeNull();
    expect(
      codeOf(
        await caught(
          updatePost(deps, ADMIN, ideaPost?.id ?? "", { platforms: ["portal_inmobiliario"] }),
        ),
      ),
    ).toBe("POST_INVALID");
    expect(
      codeOf(await caught(updatePost(deps, ADMIN, ideaPost?.id ?? "", { platforms: [] }))),
    ).toBe("POST_INVALID");
  });
});

describe("un plan activo por marca y la lista de planes (F9-T20)", () => {
  it("dos pedidos a la vez: uno crea el plan y el otro recibe ese", async () => {
    const t = await setup();
    const [first, second] = await Promise.all([
      requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id }),
      requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id }),
    ]);
    expect(first?.run.id).toBe(second?.run.id);
    expect([first?.reused, second?.reused].sort()).toEqual([false, true]);
    expect(t.planRuns.all()).toHaveLength(1);
  });

  it("listPlanRuns: los de la marca, dentro del alcance", async () => {
    const t = await setup();
    const { run } = await t.plan({ count: 1 });
    const deps = { planRuns: t.planRuns };
    expect(
      (await listPlanRuns(deps, ADMIN, { brokerId: t.broker.id })).map((item) => item.id),
    ).toEqual([run.id]);
    expect((await listPlanRuns(deps, brandUser(t.broker.id))).map((item) => item.id)).toEqual([
      run.id,
    ]);
    expect(codeOf(await caught(listPlanRuns(deps, ADMIN)))).toBe("PLAN_RUN_INVALID");
    expect(
      codeOf(await caught(listPlanRuns(deps, brandUser(t.other.id), { brokerId: t.broker.id }))),
    ).toBe("BROKER_NOT_FOUND");
    expect(
      codeOf(await caught(listPlanRuns(deps, ADMIN, { brokerId: t.broker.id, limit: 0 }))),
    ).toBe("PLAN_RUN_INVALID");
  });

  it("si quien pidió el plan ya no existe, las ideas se guardan sin autor", async () => {
    const t = await setup();
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    // Como la FK de Postgres: el primer intento con `created_by` falla.
    let calls = 0;
    const planRuns = {
      ...t.planRuns,
      markSucceeded: async (id: string, result: Parameters<typeof t.planRuns.markSucceeded>[1]) => {
        calls += 1;
        if (result.ideas?.some((item) => item.createdBy != null)) {
          throw new AppError("POST_REFERENCE_INVALID", "El usuario del post no existe");
        }
        return t.planRuns.markSucceeded(id, result);
      },
    };
    const result = await runPlan(
      { ...t.runDeps, planRuns },
      { planRunId: run.id, isLastAttempt: false },
    );
    expect(result.outcome).toBe("succeeded");
    expect(calls).toBe(2);
    const ideas = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.every((post) => post.createdBy === null)).toBe(true);
  });

  it("si el segundo intento también falla con POST_REFERENCE_INVALID (la marca se borró), el error sube y el plan queda failed", async () => {
    const t = await setup();
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, { brokerId: t.broker.id });
    const tried: (string | null | undefined)[][] = [];
    const planRuns = {
      ...t.planRuns,
      markSucceeded: async (
        _id: string,
        result: Parameters<typeof t.planRuns.markSucceeded>[1],
      ) => {
        tried.push((result.ideas ?? []).map((item) => item.createdBy));
        throw new AppError("POST_REFERENCE_INVALID", "El corredor del post no existe");
      },
    };
    const error = await caught(
      runPlan({ ...t.runDeps, planRuns }, { planRunId: run.id, isLastAttempt: false }),
    );
    expect(codeOf(error)).toBe("POST_REFERENCE_INVALID");
    // Primero con autor y después sin él; no hay un tercer intento.
    expect(tried).toHaveLength(2);
    expect(tried[0]?.every((createdBy) => createdBy === ADMIN.id)).toBe(true);
    expect(tried[1]?.every((createdBy) => createdBy === null)).toBe(true);
    expect(await t.planRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "POST_REFERENCE_INVALID" },
    });
    expect(await t.posts.list({ planRunId: run.id }, { kind: "all" })).toEqual([]);
  });

  it("lo planificado en las semanas del borde ocupa su cupo, leído por rango de fechas (F9-T21)", async () => {
    const t = await setup();
    // Lunes 19 y martes 20 (antes del período, que empieza el miércoles 21): LinkedIn publica 2 por
    // semana, así que esa semana ya está llena para LinkedIn.
    for (const [topic, plannedAt] of [
      ["Ya planificado el lunes", "2026-10-19T12:00:00Z"],
      ["Ya planificado el martes", "2026-10-20T12:00:00Z"],
    ] as const) {
      await t.posts.create({
        brokerId: t.broker.id,
        topic,
        kind: "text",
        plannedAt: new Date(plannedAt),
        platforms: ["linkedin"],
      });
    }
    // Sin `listRecent` (como si sus 300 más nuevos no los trajeran): lo planificado se lee aparte.
    const posts = { ...t.posts, listRecent: async () => [] };
    const { run } = await requestPlanRun(t.requestDeps, ADMIN, {
      brokerId: t.broker.id,
      platforms: ["linkedin"],
      count: 2,
    });
    const result = await runPlan(
      { ...t.runDeps, posts },
      { planRunId: run.id, isLastAttempt: false },
    );
    expect(result.outcome).toBe("succeeded");
    // Desde F9.5 (ADR-0034) la IA no ve lo planificado: las fechas las pone el código.
    const prompt = (t.llm as ReturnType<typeof samplePlanProvider>).requests[0]?.prompt ?? "";
    expect(prompt).not.toContain("ya_planificados");
    // Ninguna idea de LinkedIn cae en esa semana.
    const ideas = await t.posts.list({ planRunId: run.id }, { kind: "all" });
    expect(ideas.length).toBeGreaterThan(0);
    for (const idea of ideas) {
      expect((idea.plannedAt as Date) >= new Date("2026-10-26T03:00:00Z")).toBe(true);
    }
  });
});
