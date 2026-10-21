import { randomUUID } from "node:crypto";
import { type BrokerData, emptyEditorialProfileData } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { brokerDetailResponseSchema, errorBodySchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F7-T13 y T14 (spec F7 §4.6 y §4.13): crear, ver y editar corredores, el logo y la planilla.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-marca";

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
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("mio"));
  const theirs = await deps.brokers.create(brokerData("ajeno"));
  const user = auth.repos.seed.user({
    email: "corredor-marca@ejemplo.cl",
    name: "Corredor",
    role: "broker",
    brokerId: mine.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: { method?: string; json?: unknown; form?: FormData } = {}) =>
      app.request(path, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method !== undefined && init.method !== "GET" ? { origin: ORIGIN } : {}),
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        ...(init.form === undefined ? {} : { body: init.form }),
      });
  return { deps, mine, theirs, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

const logoForm = (bytes: Uint8Array, name = "logo.png") => {
  const form = new FormData();
  form.append("logo", new File([bytes as Uint8Array<ArrayBuffer>], name));
  return form;
};

describe("POST /brokers", () => {
  it("el administrador crea con la marca normalizada y la lista de alta", async () => {
    const s = await setup();
    const response = await s.admin("/brokers", {
      method: "POST",
      json: {
        slug: "nuevo",
        name: "Persona Nueva",
        brandName: "Nueva",
        primaryColor: "#aabbcc",
        instagramHandle: "@nueva",
        llmMonthlyCapUsd: 20,
      },
    });
    expect(response.status).toBe(201);
    const body = brokerDetailResponseSchema.parse(await response.json());
    expect(body.broker).toMatchObject({
      slug: "nuevo",
      primaryColor: "#AABBCC",
      secondaryColor: "#AABBCC",
      instagramHandle: "nueva",
      operatorOwned: false,
      llmMonthlyCapUsd: 20,
    });
    expect(body.onboarding.map((step) => [step.key, step.done])).toEqual([
      ["brand", true],
      ["logo", false],
      ["whatsapp", false],
      ["user", false],
      ["instagram", false],
      ["mercadolibre", false],
      ["marketplace", false],
    ]);
  });

  it("slug repetido 409, colores inválidos 400, y el corredor no puede crear (403)", async () => {
    const s = await setup();
    const valid = { slug: "mio", name: "X", brandName: "X", primaryColor: "#000000" };
    const taken = await s.admin("/brokers", { method: "POST", json: valid });
    expect([taken.status, (await errorOf(taken)).code]).toEqual([409, "BROKER_SLUG_TAKEN"]);
    const color = await s.admin("/brokers", {
      method: "POST",
      json: { ...valid, slug: "otro", primaryColor: "rojo" },
    });
    expect(color.status).toBe(400);
    expect(await errorOf(color)).toMatchObject({
      code: "BROKER_INVALID",
      issues: [{ code: "BROKER_FIELD_INVALID", field: "primaryColor" }],
    });
    const unknown = await s.admin("/brokers", {
      method: "POST",
      json: { ...valid, slug: "otro", autoPublish: true },
    });
    expect(unknown.status).toBe(400);
    const forbidden = await s.broker("/brokers", {
      method: "POST",
      json: { ...valid, slug: "otro" },
    });
    expect(forbidden.status).toBe(403);
  });
});

describe("la lista de alta de una marca (ensayo de la demo de F9)", () => {
  it("una marca no pide WhatsApp, logo, Mercado Libre ni Marketplace: pide el perfil y una red", async () => {
    const s = await setup();
    const created = await s.admin("/brokers", {
      method: "POST",
      json: {
        slug: "agentpey",
        name: "AgentPey",
        brandName: "AgentPey",
        primaryColor: "#112233",
        kind: "brand",
      },
    });
    expect(created.status).toBe(201);
    const brand = brokerDetailResponseSchema.parse(await created.json());
    expect(brand.onboarding.map((step) => [step.key, step.done])).toEqual([
      ["brand", true],
      ["editorial", false],
      ["user", false],
      ["networks", false],
    ]);
    await s.deps.editorialProfiles.upsert(brand.broker.id, {
      ...emptyEditorialProfileData(),
      pillars: [{ key: "producto", name: "Producto", description: "", weight: 1 }],
      facts: ["AgentPey publica avisos con IA"],
    });
    await s.deps.platformAccounts.upsertConnected({
      brokerId: brand.broker.id,
      platform: "linkedin",
      externalAccountId: "li-agentpey",
      displayName: "LinkedIn AgentPey",
      tokenExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      meta: { mode: "manual" },
      credentials: { accessToken: "li-token-agentpey" },
    });
    const got = brokerDetailResponseSchema.parse(
      await (await s.admin(`/brokers/${brand.broker.id}`)).json(),
    );
    expect(got.onboarding.map((step) => [step.key, step.done])).toEqual([
      ["brand", true],
      ["editorial", true],
      ["user", false],
      ["networks", true],
    ]);
  });
});

describe("GET y PATCH /brokers/:id", () => {
  it("el corredor ve y edita su marca", async () => {
    const s = await setup();
    const got = brokerDetailResponseSchema.parse(
      await (await s.broker(`/brokers/${s.mine.id}`)).json(),
    );
    expect(got.broker.slug).toBe("mio");
    expect(got.onboarding.find((step) => step.key === "user")).toMatchObject({
      done: false,
      owner: "broker",
    });
    const response = await s.broker(`/brokers/${s.mine.id}`, {
      method: "PATCH",
      json: { brandName: "Mi Marca", whatsapp: "+56 9 2222 3333", fixedHashtags: ["casas"] },
    });
    expect(response.status).toBe(200);
    const body = brokerDetailResponseSchema.parse(await response.json());
    expect(body.broker).toMatchObject({
      brandName: "Mi Marca",
      whatsapp: "+56 9 2222 3333",
      fixedHashtags: ["#casas"],
    });
    expect(body.onboarding.find((step) => step.key === "whatsapp")?.done).toBe(true);
  });

  it.each([[{ operatorOwned: true }], [{ llmMonthlyCapUsd: 5 }], [{ autoPublish: true }]])(
    "el corredor no puede cambiar %o (403) y nada cambia",
    async (json) => {
      const s = await setup();
      const response = await s.broker(`/brokers/${s.mine.id}`, { method: "PATCH", json });
      expect([response.status, (await errorOf(response)).code]).toEqual([403, "FORBIDDEN"]);
      expect(await s.deps.brokers.findById(s.mine.id)).toEqual(s.mine);
    },
  );

  it("el corredor de otro: 404 igual que uno que no existe (GET, PATCH, logo y planilla)", async () => {
    const s = await setup();
    for (const id of [s.theirs.id, randomUUID()]) {
      const responses = [
        await s.broker(`/brokers/${id}`),
        await s.broker(`/brokers/${id}`, { method: "PATCH", json: { brandName: "X" } }),
        await s.broker(`/brokers/${id}/logo`, {
          method: "POST",
          form: logoForm(new Uint8Array([0x89, 1, 2])),
        }),
        await s.broker(`/brokers/${id}/template.xlsx`),
      ];
      for (const response of responses) {
        expect([response.status, (await errorOf(response)).code]).toEqual([
          404,
          "BROKER_NOT_FOUND",
        ]);
      }
    }
    expect(await s.deps.brokers.findById(s.theirs.id)).toEqual(s.theirs);
  });

  it("el administrador cambia propio, tope y autoPublish; un campo desconocido es 400", async () => {
    const s = await setup();
    const response = await s.admin(`/brokers/${s.theirs.id}`, {
      method: "PATCH",
      json: { operatorOwned: true, llmMonthlyCapUsd: 7.5, autoPublish: true },
    });
    expect(brokerDetailResponseSchema.parse(await response.json()).broker).toMatchObject({
      operatorOwned: true,
      llmMonthlyCapUsd: 7.5,
      autoPublish: true,
    });
    const unknown = await s.admin(`/brokers/${s.theirs.id}`, {
      method: "PATCH",
      json: { slug: "cambiado" },
    });
    expect(unknown.status).toBe(400);
  });
});

describe("POST /brokers/:id/logo", () => {
  it("el corredor sube su logo: queda en el corredor", async () => {
    const s = await setup();
    const response = await s.broker(`/brokers/${s.mine.id}/logo`, {
      method: "POST",
      form: logoForm(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    });
    expect(response.status).toBe(200);
    const logoMediaId = (await s.deps.brokers.findById(s.mine.id))?.logoMediaId;
    expect(logoMediaId).not.toBeNull();
    const detail = brokerDetailResponseSchema.parse(
      await (await s.broker(`/brokers/${s.mine.id}`)).json(),
    );
    expect(detail.onboarding.find((step) => step.key === "logo")?.done).toBe(true);
  });

  it("un SVG es 415 LOGO_INVALID y uno de 6 MB, 413", async () => {
    const s = await setup();
    const svg = await s.broker(`/brokers/${s.mine.id}/logo`, {
      method: "POST",
      form: logoForm(new TextEncoder().encode("<svg/>"), "logo.svg"),
    });
    expect([svg.status, (await errorOf(svg)).code]).toEqual([415, "LOGO_INVALID"]);
    const big = new Uint8Array(6 * 1024 * 1024);
    big[0] = 0x89;
    const large = await s.broker(`/brokers/${s.mine.id}/logo`, {
      method: "POST",
      form: logoForm(big),
    });
    expect([large.status, (await errorOf(large)).code]).toEqual([413, "REQUEST_TOO_LARGE"]);
    expect((await s.deps.brokers.findById(s.mine.id))?.logoMediaId).toBeNull();
  });
});

describe("GET /brokers/:id/template.xlsx", () => {
  it("baja la planilla del corredor como archivo", async () => {
    const s = await setup();
    const response = await s.broker(`/brokers/${s.mine.id}/template.xlsx`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="planilla-mio.xlsx"',
    );
    expect(await response.text()).toBe("planilla de mio");
  });
});
