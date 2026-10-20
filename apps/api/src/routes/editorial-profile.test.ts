import { randomUUID } from "node:crypto";
import type { BrokerData } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { editorialProfileResponseSchema, errorBodySchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9-T09 (spec F9 §4.3 y §4.10): `GET/PUT /brokers/:id/editorial-profile`. Solo lo edita el
// administrador o el corredor de esa marca, y el perfil de una marca nunca se entrega a otra.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-perfil";

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

const profile = {
  languages: ["es", "en"],
  audience: "Corredores independientes",
  pillars: [{ key: "producto", name: "Producto", description: "Lo que hace", weight: 2 }],
  facts: ["AgentSales publica en Instagram", "Lo construye una persona", "Partió en 2026"],
  avoid: ["promesas de venta"],
  cadence: { instagram: { postsPerWeek: 3, days: ["mon", "thu"], hours: ["10:00"] } },
  defaultHashtags: ["agentsales", "#construirenpublico"],
};

async function setup() {
  const auth = testAuth();
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("mia"));
  const theirs = await deps.brokers.create(brokerData("ajena"));
  const user = auth.repos.seed.user({
    email: "corredor-perfil@ejemplo.cl",
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
  return { deps, mine, theirs, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;
const profileOf = async (response: Response) =>
  editorialProfileResponseSchema.parse(await response.json()).profile;
const path = (id: string) => `/brokers/${id}/editorial-profile`;

describe("GET /brokers/:id/editorial-profile", () => {
  it("sin perfil guardado entrega el vacío por defecto (no 404)", async () => {
    const s = await setup();
    const response = await s.broker(path(s.mine.id));
    expect(response.status).toBe(200);
    expect(await profileOf(response)).toEqual({
      brokerId: s.mine.id,
      languages: ["es"],
      audience: null,
      pillars: [],
      facts: [],
      avoid: [],
      cadence: {},
      defaultHashtags: [],
      updatedAt: null,
    });
  });
});

describe("PUT /brokers/:id/editorial-profile", () => {
  it("el corredor guarda el de su marca, normalizado, y GET lo devuelve", async () => {
    const s = await setup();
    const response = await s.broker(path(s.mine.id), { method: "PUT", json: profile });
    expect(response.status).toBe(200);
    const saved = await profileOf(response);
    expect(saved).toMatchObject({
      brokerId: s.mine.id,
      languages: ["es", "en"],
      cadence: {
        instagram: { postsPerWeek: 3, days: ["mon", "thu"], hours: ["10:00"], languageGapHours: 6 },
      },
      defaultHashtags: ["#agentsales", "#construirenpublico"],
    });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(await profileOf(await s.broker(path(s.mine.id)))).toEqual(saved);
  });

  it("el administrador edita el de cualquier marca", async () => {
    const s = await setup();
    const response = await s.admin(path(s.theirs.id), { method: "PUT", json: profile });
    expect(response.status).toBe(200);
    expect((await s.deps.editorialProfiles.get(s.theirs.id))?.facts).toHaveLength(3);
  });

  it("un perfil inválido es 400 EDITORIAL_PROFILE_INVALID con los campos, y no cambia nada", async () => {
    const s = await setup();
    const response = await s.broker(path(s.mine.id), {
      method: "PUT",
      json: {
        ...profile,
        languages: ["es", "es"],
        pillars: [{ key: "a", name: "A", weight: 0 }],
        cadence: { portal_inmobiliario: { postsPerWeek: 1 } },
      },
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("EDITORIAL_PROFILE_INVALID");
    expect(error.issues?.map((issue) => issue.field)).toEqual([
      "languages",
      "pillars",
      "cadence.portal_inmobiliario",
    ]);
    expect(await s.deps.editorialProfiles.get(s.mine.id)).toBeNull();
  });

  it("el cuerpo es estricto: un brokerId o un campo desconocido es 400, sin escribir", async () => {
    const s = await setup();
    for (const json of [
      { ...profile, brokerId: s.theirs.id },
      { ...profile, default_hashtags: [] },
      { languages: ["es"] },
    ]) {
      const response = await s.broker(path(s.mine.id), { method: "PUT", json });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("REQUEST_INVALID");
    }
    expect(await s.deps.editorialProfiles.get(s.mine.id)).toBeNull();
    expect(await s.deps.editorialProfiles.get(s.theirs.id)).toBeNull();
  });

  it("el perfil de otra marca no existe para un corredor: ni leerlo ni editarlo", async () => {
    const s = await setup();
    await s.admin(path(s.theirs.id), { method: "PUT", json: profile });
    for (const init of [{}, { method: "PUT", json: { ...profile, facts: [] } }]) {
      const response = await s.broker(path(s.theirs.id), init);
      expect(response.status).toBe(404);
      const error = await errorOf(response);
      expect(error.code).toBe("BROKER_NOT_FOUND");
      // Nada del perfil ajeno se filtra en el error.
      expect(JSON.stringify(error)).not.toContain("AgentSales publica");
    }
    expect((await s.deps.editorialProfiles.get(s.theirs.id))?.facts).toHaveLength(3);
  });

  it("un corredor que no existe es 404 también para el administrador", async () => {
    const s = await setup();
    const response = await s.admin(path(randomUUID()), { method: "PUT", json: profile });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("BROKER_NOT_FOUND");
  });
});
