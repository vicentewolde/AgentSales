import type { BrokerData } from "@agentsales/core";
import { createInMemoryJobQueue } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  brandKnowledgeResponseSchema,
  errorBodySchema,
  knowledgeProposalsResponseSchema,
  knowledgeRunResponseSchema,
  knowledgeUpdateResponseSchema,
} from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9.7 (ADR-0043): el conocimiento de la marca por la API. Lo de otra marca es 404; el corredor
// edita el suyo; pedir una lectura encola `brand.propose`.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-conocimiento";

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

async function setup() {
  const auth = testAuth();
  const queue = createInMemoryJobQueue();
  const deps = testDeps({
    access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    queue,
  });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("mia"));
  const theirs = await deps.brokers.create(brokerData("ajena"));
  const user = auth.repos.seed.user({
    email: "corredor-conocimiento@ejemplo.cl",
    name: "Corredor",
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
  return { deps, queue, mine, theirs, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

describe("/brokers/:id/knowledge", () => {
  it("el corredor guarda su postura, tono y ejemplos; la de otra marca es 404", async () => {
    const s = await setup();
    const saved = await s.broker(`/brokers/${s.mine.id}/knowledge`, {
      method: "PUT",
      json: {
        stance: "Que los agentes compren con límites",
        tone: "Relato con escena",
        examples: [{ text: "Un ejemplo", note: "abre con una escena", favorite: true }],
      },
    });
    expect(saved.status).toBe(200);
    const { knowledge } = brandKnowledgeResponseSchema.parse(await saved.json());
    expect(knowledge).toMatchObject({ stance: "Que los agentes compren con límites" });
    expect(knowledge.examples[0]).toMatchObject({ text: "Un ejemplo", favorite: true });
    const other = await s.broker(`/brokers/${s.theirs.id}/knowledge`);
    expect(other.status).toBe(404);
    const invalid = await s.broker(`/brokers/${s.mine.id}/knowledge`, {
      method: "PUT",
      json: { stance: "x".repeat(2001), tone: null, examples: [] },
    });
    expect(invalid.status).toBe(400);
    expect(errorBodySchema.parse(await invalid.json()).error.code).toBe("KNOWLEDGE_INVALID");
  });

  it("las novedades: agregar, editar, archivar (y lo archivado no se edita)", async () => {
    const s = await setup();
    const created = await s.broker(`/brokers/${s.mine.id}/knowledge/updates`, {
      method: "POST",
      json: { project: "AgentPey en Stellar", date: "2026-11-10", text: "Pasó a testnet." },
    });
    expect(created.status).toBe(201);
    const { update } = knowledgeUpdateResponseSchema.parse(await created.json());
    const url = `/brokers/${s.mine.id}/knowledge/updates/${update.id}`;
    const edited = await s.broker(url, {
      method: "PATCH",
      json: { project: "AgentPey en Stellar", date: "2026-11-11", text: "Pasó a testnet hoy." },
    });
    expect(edited.status).toBe(200);
    expect((await s.broker(url, { method: "DELETE" })).status).toBe(200);
    const again = await s.broker(url, {
      method: "PATCH",
      json: { project: "x", date: "2026-11-11", text: "y" },
    });
    expect(again.status).toBe(409);
    const read = brandKnowledgeResponseSchema.parse(
      await (await s.broker(`/brokers/${s.mine.id}/knowledge`)).json(),
    );
    expect(read.knowledge.updates).toEqual([]);
  });

  it("pedir una lectura encola brand.propose y responde 202 sin el texto", async () => {
    const s = await setup();
    const response = await s.admin(`/brokers/${s.mine.id}/knowledge/proposals`, {
      method: "POST",
      json: { text: "Notas de la reunión: el piloto empezó con un comercio en Santiago." },
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    const { run } = knowledgeRunResponseSchema.parse(body);
    expect(JSON.stringify(body)).not.toContain("Santiago");
    expect(s.queue.jobs.map((job) => job.name)).toEqual(["brand.propose"]);
    const second = await s.admin(`/brokers/${s.mine.id}/knowledge/proposals`, {
      method: "POST",
      json: { text: "Otras notas largas de la reunión de la semana." },
    });
    expect(second.status).toBe(409);
    const list = knowledgeProposalsResponseSchema.parse(
      await (await s.admin(`/brokers/${s.mine.id}/knowledge/proposals`)).json(),
    );
    expect(list.runs.map((item) => item.id)).toEqual([run.id]);
    expect(list.pending).toEqual([]);
  });
});
