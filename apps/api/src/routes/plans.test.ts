import { randomUUID } from "node:crypto";
import {
  type BrokerData,
  editorialProfileView,
  type LLMProvider,
  postSubject,
  runPlan,
  samplePlanResponse,
} from "@agentsales/core";
import { createInMemoryJobQueue } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { ROUTE_ACCESS } from "../access.js";
import { createApp } from "../app.js";
import {
  errorBodySchema,
  ideaAcceptResponseSchema,
  planDetailResponseSchema,
  planListResponseSchema,
  planRequestResponseSchema,
  postResponseSchema,
} from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9-T21 (spec F9 §4.9 y §4.10, ADR-0030): `/plans` y aceptar o descartar una idea, de punta a punta
// en la API con dobles: pedir el plan encola `content.plan`, el "worker" lo corre con el plan de
// ejemplo (`fake`, nunca la IA real), y aceptar una idea la pasa a `draft` y encola `post.draft`.

const ORIGIN = "http://localhost:5173";
const MINE = "token-de-la-marca-plan";

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

/** El proveedor `fake` del worker: el plan de ejemplo armado con el prompt. */
const sampleLlm: LLMProvider = {
  name: "fake",
  async generateStructured(request) {
    return { data: samplePlanResponse(request.prompt), model: "fake" };
  },
};

async function setup() {
  const auth = testAuth();
  const queue = createInMemoryJobQueue();
  const deps = testDeps({
    access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    queue,
  });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("agentpey"), { kind: "brand" });
  const theirs = await deps.brokers.create(brokerData("ajena"), { kind: "brand" });
  for (const broker of [mine, theirs]) {
    await deps.editorialProfiles.upsert(broker.id, {
      ...editorialProfileView(broker.id, null),
      pillars: [{ key: "producto", name: "Producto", description: "Lo que hacemos", weight: 1 }],
      cadence: {
        linkedin: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
        x: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
      },
    });
  }
  const user = auth.repos.seed.user({
    email: "marca@ejemplo.cl",
    name: "Marca",
    role: "broker",
    brokerId: mine.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: { method?: string; json?: unknown } = {}) =>
      app.request(path, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method !== undefined && init.method !== "GET" ? { origin: ORIGIN } : {}),
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      });
  /** El worker: corre el plan con el plan de ejemplo. */
  const work = (planRunId: string) =>
    runPlan(
      {
        planRuns: deps.planRuns,
        posts: deps.posts,
        brokers: deps.brokers,
        editorialProfiles: deps.editorialProfiles,
        contentRuns: deps.contentRuns,
        llm: sampleLlm,
        newId: randomUUID,
      },
      { planRunId, isLastAttempt: true },
    );
  return { deps, queue, mine, theirs, work, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

describe("/plans: pedir, seguir y ver las ideas", () => {
  it("pedir un plan encola content.plan; corrido, trae sus ideas por fecha, sin textos", async () => {
    const s = await setup();
    const requested = await s.broker("/plans", {
      method: "POST",
      json: { days: 14, platforms: ["linkedin", "x"], count: 4 },
    });
    expect(requested.status).toBe(202);
    const { plan, reused } = planRequestResponseSchema.parse(await requested.json());
    expect(plan).toMatchObject({
      brokerId: s.mine.id,
      status: "queued",
      // En el orden de `POST_PLATFORMS`.
      platforms: ["x", "linkedin"],
      count: 4,
      error: null,
    });
    expect(reused).toBe(false);
    expect(s.queue.jobs).toEqual([
      expect.objectContaining({ name: "content.plan", data: { planRunId: plan.id } }),
    ]);
    // El período: 14 días de Chile, los dos extremos incluidos.
    const first = new Date(`${plan.firstDay}T12:00:00Z`);
    const last = new Date(`${plan.lastDay}T12:00:00Z`);
    expect((last.getTime() - first.getTime()) / 86_400_000).toBe(13);

    // Mientras sigue en cola, otro pedido recibe el mismo (`reused`).
    const again = planRequestResponseSchema.parse(
      await (await s.broker("/plans", { method: "POST", json: {} })).json(),
    );
    expect(again).toMatchObject({ plan: { id: plan.id }, reused: true });

    const waiting = planDetailResponseSchema.parse(
      await (await s.broker(`/plans/${plan.id}`)).json(),
    );
    expect(waiting).toMatchObject({ plan: { status: "queued" }, report: null, ideas: [] });

    await s.work(plan.id);
    const detail = planDetailResponseSchema.parse(
      await (await s.broker(`/plans/${plan.id}`)).json(),
    );
    expect(detail.plan.status).toBe("succeeded");
    expect(detail.report).toMatchObject({ discarded: [], warnings: expect.any(Array) });
    expect(detail.ideas).toHaveLength(4);
    for (const idea of detail.ideas) {
      expect(idea).toMatchObject({
        status: "idea",
        source: "ai",
        briefOrigin: "ai",
        planRunId: plan.id,
        texts: 0,
        latestRun: null,
      });
      expect(idea.rationale).not.toBeNull();
      expect(idea.platforms?.length).toBeGreaterThan(0);
    }
    const dates = detail.ideas.map((idea) => idea.plannedAt?.getTime() ?? 0);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));

    const list = planListResponseSchema.parse(await (await s.broker("/plans")).json());
    expect(list.plans.map((item) => [item.id, item.status])).toEqual([[plan.id, "succeeded"]]);
  });

  it("aceptar una idea la pasa a draft y encola post.draft; descartarla la archiva", async () => {
    const s = await setup();
    const { plan } = planRequestResponseSchema.parse(
      await (await s.broker("/plans", { method: "POST", json: { count: 3 } })).json(),
    );
    await s.work(plan.id);
    const { ideas } = planDetailResponseSchema.parse(
      await (await s.broker(`/plans/${plan.id}`)).json(),
    );
    const [accepted, discarded, untouched] = ideas;
    if (accepted === undefined || discarded === undefined || untouched === undefined) {
      throw new Error("faltan ideas");
    }

    const accept = await s.broker(`/posts/${accepted.id}/accept`, { method: "POST" });
    expect(accept.status).toBe(202);
    const result = ideaAcceptResponseSchema.parse(await accept.json());
    expect(result.post).toMatchObject({ id: accepted.id, status: "draft" });
    expect(result.contentRun).toMatchObject({ status: "queued" });
    expect(result.reused).toBe(false);
    expect(s.queue.jobs.at(-1)).toMatchObject({
      name: "post.draft",
      data: { contentRunId: result.contentRun.id },
    });
    // Aceptar no aprueba ni programa nada: sin publicaciones.
    expect(await s.deps.publications.listBySubject(postSubject(accepted.id))).toEqual([]);

    const discard = await s.broker(`/posts/${discarded.id}/discard`, { method: "POST" });
    expect(discard.status).toBe(200);
    expect(postResponseSchema.parse(await discard.json()).post.status).toBe("archived");

    // Algo que ya no es una idea no se acepta ni se descarta: 409, sin cambiar nada.
    for (const [path, id] of [
      ["accept", accepted.id],
      ["discard", accepted.id],
      ["accept", discarded.id],
    ] as const) {
      const response = await s.broker(`/posts/${id}/${path}`, { method: "POST" });
      expect([path, response.status]).toEqual([path, 409]);
      expect((await errorOf(response)).code).toBe("POST_NOT_IDEA");
    }

    // El plan muestra cada idea con su estado y la corrida de la aceptada.
    const after = planDetailResponseSchema.parse(
      await (await s.broker(`/plans/${plan.id}`)).json(),
    );
    const byId = new Map(after.ideas.map((idea) => [idea.id, idea]));
    expect(byId.get(accepted.id)).toMatchObject({
      status: "draft",
      latestRun: { id: result.contentRun.id, status: "queued" },
    });
    expect(byId.get(discarded.id)?.status).toBe("archived");
    expect(byId.get(untouched.id)?.status).toBe("idea");
  });

  it("editar una idea: el brief, la fecha y las redes (PATCH /posts/:id)", async () => {
    const s = await setup();
    const { plan } = planRequestResponseSchema.parse(
      await (await s.broker("/plans", { method: "POST", json: { count: 1 } })).json(),
    );
    await s.work(plan.id);
    const [idea] = planDetailResponseSchema.parse(
      await (await s.broker(`/plans/${plan.id}`)).json(),
    ).ideas;
    if (idea === undefined) throw new Error("sin idea");
    const patched = await s.broker(`/posts/${idea.id}`, {
      method: "PATCH",
      json: {
        brief: "Lo que yo sé del tema",
        plannedAt: "2026-11-05T10:00:00-03:00",
        platforms: ["x"],
      },
    });
    expect(patched.status).toBe(200);
    expect(postResponseSchema.parse(await patched.json()).post).toMatchObject({
      status: "idea",
      brief: "Lo que yo sé del tema",
      briefOrigin: "operator",
      plannedAt: new Date("2026-11-05T13:00:00Z"),
      platforms: ["x"],
    });
    const all = await s.broker(`/posts/${idea.id}`, { method: "PATCH", json: { platforms: null } });
    expect(postResponseSchema.parse(await all.json()).post.platforms).toBeNull();
    const none = await s.broker(`/posts/${idea.id}`, { method: "PATCH", json: { platforms: [] } });
    expect(none.status).toBe(400);
    const unknown = await s.broker(`/posts/${idea.id}`, {
      method: "PATCH",
      json: { platforms: ["portal_inmobiliario"] },
    });
    expect(unknown.status).toBe(400);
  });

  it("un plan que falla trae su error con qué hacer (el tope de IA)", async () => {
    const s = await setup();
    const { plan } = planRequestResponseSchema.parse(
      await (await s.broker("/plans", { method: "POST", json: {} })).json(),
    );
    await s.deps.planRuns.markRunning(plan.id);
    await s.deps.planRuns.markFailed(plan.id, {
      code: "LLM_BUDGET_EXCEEDED",
      message: "La marca llegó a su tope de IA del mes",
    });
    const detail = planDetailResponseSchema.parse(
      await (await s.broker(`/plans/${plan.id}`)).json(),
    );
    expect(detail.plan).toMatchObject({
      status: "failed",
      error: { code: "LLM_BUDGET_EXCEEDED" },
      errorAdvice: expect.stringContaining("tope de IA"),
    });
    expect(detail.report).toBeNull();
  });

  it("validación: un campo desconocido o un período fuera de rango son 400", async () => {
    const s = await setup();
    const unknown = await s.broker("/plans", { method: "POST", json: { dias: 14 } });
    expect(unknown.status).toBe(400);
    const long = await s.broker("/plans", { method: "POST", json: { days: 40 } });
    expect(long.status).toBe(400);
    expect((await errorOf(long)).code).toBe("PLAN_RUN_INVALID");
    expect(s.queue.jobs).toEqual([]);
  });
});

describe("/plans: permisos (ADR-0022, `posts.manage`)", () => {
  it("un plan o una idea de otra marca no existe (404); el administrador elige la marca", async () => {
    const s = await setup();
    const foreign = planRequestResponseSchema.parse(
      await (
        await s.admin("/plans", { method: "POST", json: { brokerId: s.theirs.id, count: 1 } })
      ).json(),
    ).plan;
    await s.work(foreign.id);
    const [foreignIdea] = await s.deps.posts.list({ planRunId: foreign.id }, { kind: "all" });
    if (foreignIdea === undefined) throw new Error("sin idea ajena");

    const missing = randomUUID();
    const seen = await s.broker(`/plans/${foreign.id}`);
    const absent = await s.broker(`/plans/${missing}`);
    expect(seen.status).toBe(404);
    const seenError = await errorOf(seen);
    const absentError = await errorOf(absent);
    expect(seenError.code).toBe("PLAN_RUN_NOT_FOUND");
    expect(seenError.message.replace(foreign.id, "ID")).toBe(
      absentError.message.replace(missing, "ID"),
    );
    for (const path of [`/plans?brokerId=${s.theirs.id}`, `/posts/${foreignIdea.id}`]) {
      expect([path, (await s.broker(path)).status]).toEqual([path, 404]);
    }
    for (const action of ["accept", "discard"]) {
      const response = await s.broker(`/posts/${foreignIdea.id}/${action}`, { method: "POST" });
      expect([action, response.status]).toEqual([action, 404]);
      expect((await errorOf(response)).code).toBe("POST_NOT_FOUND");
    }
    const intoOther = await s.broker("/plans", {
      method: "POST",
      json: { brokerId: s.theirs.id },
    });
    expect(intoOther.status).toBe(404);
    expect((await errorOf(intoOther)).code).toBe("BROKER_NOT_FOUND");
    // Nada de lo ajeno cambió.
    expect((await s.deps.posts.get(foreignIdea.id))?.status).toBe("idea");

    // El administrador ve los de cualquier marca, pero tiene que decir cuál.
    expect((await s.admin(`/plans/${foreign.id}`)).status).toBe(200);
    const adminList = planListResponseSchema.parse(
      await (await s.admin(`/plans?brokerId=${s.theirs.id}`)).json(),
    );
    expect(adminList.plans.map((plan) => plan.id)).toEqual([foreign.id]);
    const noBrand = await s.admin("/plans");
    expect(noBrand.status).toBe(400);
    expect((await errorOf(noBrand)).code).toBe("PLAN_RUN_INVALID");
    const noBrandRequest = await s.admin("/plans", { method: "POST", json: {} });
    expect(noBrandRequest.status).toBe(400);
  });

  it("cada ruta del plan está en la tabla de permisos, como de sesión", () => {
    for (const route of [
      "POST /plans",
      "GET /plans",
      "GET /plans/:id",
      "POST /posts/:id/accept",
      "POST /posts/:id/discard",
    ]) {
      expect([route, ROUTE_ACCESS[route]]).toEqual([route, "session"]);
    }
  });
});
