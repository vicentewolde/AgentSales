import type { BrokerData, NewListing } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { leadListResponseSchema, leadResponseSchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F10-T04 y T05 (ADR-0033): el webhook de ManyChat con el secreto del corredor y las rutas de
// leads con el alcance de la sesión.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-con-leads";

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

const newListing = (brokerId: string): NewListing => ({
  brokerId,
  externalRef: "P-1",
  category: "real_estate",
  source: "xlsx",
  operation: "sale",
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: null,
  unitNumber: null,
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF",
  highlights: null,
  internalNotes: null,
  attributes: {},
  sourceHash: "hash",
});

const BODY = {
  subscriber_id: "mc-1",
  first_name: "Ana",
  phone: "+56911112222",
  consent: true,
  consent_text: "Acepto que me contacten",
};

async function setup() {
  const auth = testAuth();
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.create(brokerData("mio"));
  const theirs = await deps.brokers.create(brokerData("ajeno"));
  const myListing = await deps.listings.create(newListing(mine.id));
  const theirListing = await deps.listings.create(newListing(theirs.id));
  const user = auth.repos.seed.user({
    email: "corredor-leads@ejemplo.cl",
    name: "Corredor",
    role: "broker",
    brokerId: mine.id,
  });
  const other = auth.repos.seed.user({
    email: "otro@ejemplo.cl",
    name: "Otro",
    role: "broker",
    brokerId: theirs.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: RequestInit & { json?: unknown } = {}) =>
      app.request(path, {
        ...init,
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method === "POST" ? { "content-type": "application/json" } : {}),
        },
      });
  const secretFor = async (brokerId: string) => {
    const res = await as(TEST_ADMIN_TOKEN)(`/brokers/${brokerId}/leads/webhook-secret`, {
      method: "POST",
    });
    return ((await res.json()) as { secret: string }).secret;
  };
  // El webhook no lleva sesión ni Origin: llega de ManyChat.
  const hook = (brokerId: string, secret: string | undefined, body: unknown) =>
    app.request(`/webhooks/manychat/${brokerId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === undefined ? {} : { "x-agentsales-secret": secret }),
      },
      body: JSON.stringify(body),
    });
  return {
    deps,
    app,
    mine,
    theirs,
    myListing,
    theirListing,
    user,
    other,
    broker: as(MINE),
    admin: as(TEST_ADMIN_TOKEN),
    secretFor,
    hook,
  };
}

describe("POST /webhooks/manychat/:brokerId", () => {
  it("sin secreto, con uno equivocado o de un corredor sin secreto: 401 igual", async () => {
    const s = await setup();
    const secret = await s.secretFor(s.mine.id);
    expect((await s.hook(s.mine.id, undefined, BODY)).status).toBe(401);
    expect((await s.hook(s.mine.id, "otro", BODY)).status).toBe(401);
    // El secreto de un corredor no abre a otro, ni a uno que no existe.
    expect((await s.hook(s.theirs.id, secret, BODY)).status).toBe(401);
    expect((await s.hook("no-es-uuid", secret, BODY)).status).toBe(401);
    expect((await s.deps.leads.list({ brokerId: s.mine.id }, 10)).length).toBe(0);
  });

  it("guarda el lead, responde sin datos personales y no lo duplica", async () => {
    const s = await setup();
    const secret = await s.secretFor(s.mine.id);
    const first = await s.hook(s.mine.id, secret, { ...BODY, listing_id: s.myListing.id });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, created: true });
    const again = await s.hook(s.mine.id, secret, BODY);
    expect(await again.json()).toEqual({ ok: true, created: false });
    const [lead, ...rest] = await s.deps.leads.list({ brokerId: s.mine.id }, 10);
    expect(rest).toEqual([]);
    expect(lead).toMatchObject({ source: "manychat", name: "Ana", listingId: s.myListing.id });
  });

  it("sin consentimiento, sin contacto o con una propiedad ajena: 400 y no se guarda", async () => {
    const s = await setup();
    const secret = await s.secretFor(s.mine.id);
    const noConsent = await s.hook(s.mine.id, secret, { ...BODY, consent: false });
    expect(noConsent.status).toBe(400);
    expect(((await noConsent.json()) as { error: { code: string } }).error.code).toBe(
      "LEAD_CONSENT_REQUIRED",
    );
    expect((await s.hook(s.mine.id, secret, { ...BODY, phone: null })).status).toBe(400);
    const foreign = await s.hook(s.mine.id, secret, { ...BODY, listing_id: s.theirListing.id });
    expect(foreign.status).toBe(400);
    expect((await s.hook(s.mine.id, secret, "no es un objeto")).status).toBe(400);
    expect((await s.deps.leads.list({ brokerId: s.mine.id }, 10)).length).toBe(0);
  });

  it("rotar el secreto deja sin efecto el anterior", async () => {
    const s = await setup();
    const old = await s.secretFor(s.mine.id);
    const fresh = await s.secretFor(s.mine.id);
    expect((await s.hook(s.mine.id, old, BODY)).status).toBe(401);
    expect((await s.hook(s.mine.id, fresh, BODY)).status).toBe(200);
  });

  it("rechaza un cuerpo enorme", async () => {
    const s = await setup();
    const secret = await s.secretFor(s.mine.id);
    const res = await s.hook(s.mine.id, secret, { ...BODY, consent_text: "x".repeat(40_000) });
    expect(res.status).toBe(413);
  });
});

describe("rutas de leads", () => {
  async function withLead() {
    const s = await setup();
    const secret = await s.secretFor(s.mine.id);
    await s.hook(s.mine.id, secret, { ...BODY, listing_id: s.myListing.id });
    const [lead] = await s.deps.leads.list({ brokerId: s.mine.id }, 10);
    if (lead === undefined) throw new Error("falta el lead");
    return { s, lead };
  }

  it("el corredor lista los suyos con filtros; el de otro corredor no puede", async () => {
    const { s, lead } = await withLead();
    const list = leadListResponseSchema.parse(
      await (await s.broker(`/brokers/${s.mine.id}/leads?status=new`)).json(),
    );
    expect(list.leads.map((l) => l.id)).toEqual([lead.id]);
    const none = leadListResponseSchema.parse(
      await (await s.broker(`/brokers/${s.mine.id}/leads?status=won`)).json(),
    );
    expect(none.leads).toEqual([]);
    expect((await s.broker(`/brokers/${s.theirs.id}/leads`)).status).toBe(404);
    // El administrador ve los de cualquier corredor.
    expect((await s.admin(`/brokers/${s.mine.id}/leads`)).status).toBe(200);
  });

  it("un lead ajeno es 404 para otro corredor", async () => {
    const { s, lead } = await withLead();
    const otherToken = "token-del-otro";
    // Sembrar una sesión del otro corredor.
    const auth = s.deps.auth as unknown as ReturnType<typeof testAuth>;
    auth.repos.seed.session({
      userId: s.other.id,
      tokenHash: auth.tokens.hash(otherToken),
      client: "panel",
    });
    const res = await s.app.request(`/leads/${lead.id}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(404);
    expect((await s.broker(`/leads/${lead.id}`)).status).toBe(200);
  });

  it("cambia de estado según las transiciones", async () => {
    const { s, lead } = await withLead();
    const ok = await s.broker(`/leads/${lead.id}/status`, {
      method: "POST",
      json: { status: "contacted" },
    });
    expect(leadResponseSchema.parse(await ok.json()).lead.status).toBe("contacted");
    const bad = await s.broker(`/leads/${lead.id}/status`, {
      method: "POST",
      json: { status: "new" },
    });
    expect(bad.status).toBe(409);
  });

  it("asigna solo a un usuario del mismo corredor, y se puede quitar", async () => {
    const { s, lead } = await withLead();
    const ok = await s.broker(`/leads/${lead.id}/assign`, {
      method: "POST",
      json: { userId: s.user.id },
    });
    expect(leadResponseSchema.parse(await ok.json()).lead.assignedTo).toBe(s.user.id);
    const foreign = await s.broker(`/leads/${lead.id}/assign`, {
      method: "POST",
      json: { userId: s.other.id },
    });
    expect(foreign.status).toBe(400);
    const none = await s.broker(`/leads/${lead.id}/assign`, {
      method: "POST",
      json: { userId: null },
    });
    expect(leadResponseSchema.parse(await none.json()).lead.assignedTo).toBeNull();
  });

  it("borrar deja nulos los datos personales y conserva la atribución", async () => {
    const { s, lead } = await withLead();
    const res = await s.broker(`/leads/${lead.id}/erase`, { method: "POST" });
    const erased = leadResponseSchema.parse(await res.json()).lead;
    expect(erased).toMatchObject({ name: null, phone: null, email: null });
    expect(erased.erasedAt).not.toBeNull();
    expect(erased.listingId).toBe(s.myListing.id);
    // Un lead borrado ya no cambia de estado.
    const after = await s.broker(`/leads/${lead.id}/status`, {
      method: "POST",
      json: { status: "contacted" },
    });
    expect(after.status).toBe(409);
  });

  it("exporta a CSV sin que una planilla tome un valor por fórmula", async () => {
    const s = await setup();
    const secret = await s.secretFor(s.mine.id);
    await s.hook(s.mine.id, secret, { ...BODY, name: "=HYPERLINK(1)" });
    const res = await s.broker(`/brokers/${s.mine.id}/leads.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("'=HYPERLINK(1)");
    expect((await s.broker(`/brokers/${s.theirs.id}/leads.csv`)).status).toBe(404);
  });

  it("rotar el secreto no deja el secreto en las respuestas de lista", async () => {
    const s = await setup();
    const res = await s.broker(`/brokers/${s.mine.id}/leads/webhook-secret`, { method: "POST" });
    const body = (await res.json()) as { secret: string; path: string };
    expect(body.secret.length).toBeGreaterThan(20);
    expect(body.path).toBe(`/api/webhooks/manychat/${s.mine.id}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
