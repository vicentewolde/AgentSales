import { type BrokerData, chileDateOf, parseChileTime } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  dailyReadinessResponseSchema,
  errorBodySchema,
  postWeekApproveResponseSchema,
  postWeekResponseSchema,
} from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9.5-T27: «Aprobar la semana» y la «Lista para publicar a diario» de una marca, bajo
// `/brokers/:id`. Un corredor solo llega a lo suyo (lo ajeno es 404) y nada se publica en el momento.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-semana-t27";

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

/** Un día de la semana que viene (hora de Chile), lejos del borde de «muy pronto». */
const DAY = chileDateOf(new Date(Date.now() + 8 * 86_400_000));

async function setup() {
  const auth = testAuth();
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("agentpey"), { kind: "brand" });
  const theirs = await deps.brokers.create(brokerData("ajena"), { kind: "brand" });
  const user = auth.repos.seed.user({
    email: "marca@ejemplo.cl",
    name: "Marca",
    role: "broker",
    brokerId: theirs.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "cli" });
  await deps.platformAccounts.upsertConnected({
    brokerId: mine.id,
    platform: "linkedin",
    externalAccountId: "perfil-1",
    displayName: "Vinny",
    tokenExpiresAt: null,
    meta: { mode: "manual" },
    credentials: { accessToken: "token-de-prueba" },
  });
  const post = await deps.posts.create({
    brokerId: mine.id,
    topic: "Lo que aprendí esta semana",
    kind: "text",
    status: "draft",
    plannedAt: parseChileTime(`${DAY} 10:00`),
  });
  const run = await deps.contentRuns.create({ postId: post.id, texts: true });
  await deps.contentRuns.markRunning(run.id);
  await deps.contentRuns.markSucceeded(run.id, {
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
  return { deps, auth, mine, theirs, post, admin: as(TEST_ADMIN_TOKEN), other: as(MINE) };
}

describe("/brokers/:id/week", () => {
  it("muestra la semana y la aprueba: programa el post a su fecha, en simulación, sin publicar", async () => {
    const s = await setup();
    const week = postWeekResponseSchema.parse(
      await (await s.admin(`/brokers/${s.mine.id}/week?day=${DAY}`)).json(),
    );
    expect(week.posts.map((item) => item.post.id)).toEqual([s.post.id]);
    expect(week.posts[0]?.contents.map((content) => content.platform)).toEqual(["linkedin"]);

    const response = await s.admin(`/brokers/${s.mine.id}/week/approve`, {
      method: "POST",
      json: { day: DAY },
    });
    expect(response.status).toBe(200);
    const result = postWeekApproveResponseSchema.parse(await response.json());
    expect(result.dryRun).toBe(true);
    expect(result.posts[0]).toMatchObject({
      postId: s.post.id,
      approved: [{ platform: "linkedin", language: "es" }],
      problems: [],
    });
    expect(result.posts[0]?.scheduled[0]?.at).toEqual(parseChileTime(`${DAY} 10:00`));
    const publications = await s.deps.publications.listBySubject({ kind: "post", id: s.post.id });
    expect(publications.map((p) => [p.status, p.dryRun])).toEqual([["scheduled", true]]);
  });

  it("lo de otra marca es 404, y un día que no existe es 400", async () => {
    const s = await setup();
    for (const [path, method] of [
      [`/brokers/${s.mine.id}/week?day=${DAY}`, "GET"],
      [`/brokers/${s.mine.id}/week/approve`, "POST"],
      [`/brokers/${s.mine.id}/daily-readiness`, "GET"],
    ] as const) {
      const response = await s.other(path, {
        method,
        ...(method === "POST" ? { json: {} } : {}),
      });
      expect(response.status).toBe(404);
    }
    const bad = await s.admin(`/brokers/${s.mine.id}/week/approve`, {
      method: "POST",
      json: { day: "2026-02-30" },
    });
    expect(bad.status).toBe(400);
    expect(errorBodySchema.parse(await bad.json()).error.code).toBe("WEEK_INVALID");
  });
});

describe("/brokers/:id/daily-readiness", () => {
  it("da la lista de la marca: su modo, el worker y una fila por red con qué falta", async () => {
    const s = await setup();
    const response = await s.admin(`/brokers/${s.mine.id}/daily-readiness`);
    expect(response.status).toBe(200);
    const { readiness } = dailyReadinessResponseSchema.parse(await response.json());
    expect(readiness.slug).toBe("agentpey");
    expect(readiness.brand.map((item) => item.key)).toEqual([
      "mode",
      "worker",
      "ai_cap",
      "image_ai_cap",
    ]);
    // Al administrador: sin horario y sin latidos que leer, el worker falta.
    expect(readiness.brand[1]).toMatchObject({ state: "missing" });
    expect(readiness.brand[0]).toMatchObject({ state: "missing" });
    expect(readiness.networks.map((network) => network.platform)).toEqual(["linkedin"]);
    expect(readiness.networks[0]?.items.find((item) => item.key === "account")?.state).toBe("ok");
  });

  it("el estado del worker solo lo ve el administrador; con un latido reciente, está encendido", async () => {
    const s = await setup();
    const beat = new Date();
    s.deps.healthDetails = {
      ...s.deps.healthDetails,
      workerHeartbeats: async () => [
        { processId: "w1", startedAt: beat, beatAt: beat, stoppedAt: null },
      ],
    };
    const app = createApp(s.deps);
    const asAdmin = await app.request(`/brokers/${s.mine.id}/daily-readiness`, {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const admin = dailyReadinessResponseSchema.parse(await asAdmin.json()).readiness;
    expect(admin.brand[1]).toMatchObject({ key: "worker", state: "info" });

    // Un usuario de la marca no lo ve: «no se sabe».
    const { auth } = s;
    const user = auth.repos.seed.user({
      email: "agentpey@ejemplo.cl",
      name: "AgentPey",
      role: "broker",
      brokerId: s.mine.id,
    });
    auth.repos.seed.session({
      userId: user.id,
      tokenHash: auth.tokens.hash("token-agentpey"),
      client: "cli",
    });
    const asBroker = await app.request(`/brokers/${s.mine.id}/daily-readiness`, {
      headers: { authorization: "Bearer token-agentpey" },
    });
    expect(asBroker.status).toBe(200);
    const broker = dailyReadinessResponseSchema.parse(await asBroker.json()).readiness;
    expect(broker.brand[1]).toMatchObject({ key: "worker", state: "operator" });
    expect(broker.brand[1]?.detail).toContain("solo el administrador");
  });
});
