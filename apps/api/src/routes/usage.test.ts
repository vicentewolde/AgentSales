import type { BrokerData, NewListing } from "@agentsales/core";
import { chileMonthOf, llmCallCost } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { errorBodySchema, usageResponseSchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F7-T12 (spec F7 §4.7): el gasto de IA del mes por corredor, con el alcance de la sesión, y el
// tope al pedir una preparación con textos.

const ORIGIN = "http://localhost:5173";
const MINE = "token-del-corredor-con-gasto";

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

const newListing = (brokerId: string, externalRef: string): NewListing => ({
  brokerId,
  externalRef,
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

/** US$ 0,70 con Sonnet 5.5. */
const SPEND = llmCallCost("anthropic-api", "claude-sonnet-5-5", {
  inputTokens: 300_000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 10_000,
  requestId: "req_1",
});

async function setup() {
  const auth = testAuth();
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const mine = await deps.brokers.setSettings((await deps.brokers.create(brokerData("mio"))).id, {
    llmMonthlyCapUsd: 0.5,
  });
  const theirs = await deps.brokers.create(brokerData("ajeno"));
  const listing = await deps.listings.create(newListing(mine.id, "P-mio"));
  await deps.listings.promoteToReady(listing.id);
  await deps.media.create({
    listingId: listing.id,
    brokerId: mine.id,
    kind: "image",
    storagePath: "foto",
    mime: "image/jpeg",
    bytes: 1,
    checksum: "sha",
    sortOrder: 0,
    isCover: false,
  });
  const spend = async (listingId: string) => {
    const run = await deps.contentRuns.create({ listingId, texts: true });
    await deps.contentRuns.addLlmUsage(run.id, SPEND);
    await deps.contentRuns.markFailed(run.id, { code: "LLM_OUTPUT_INVALID", message: "x" });
    return chileMonthOf(run.createdAt);
  };
  const user = auth.repos.seed.user({
    email: "corredor-gasto@ejemplo.cl",
    name: "Corredor",
    role: "broker",
    brokerId: mine.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(MINE), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method === "POST" ? { origin: ORIGIN, "content-type": "application/json" } : {}),
        },
      });
  return { deps, mine, theirs, listing, spend, broker: as(MINE), admin: as(TEST_ADMIN_TOKEN) };
}

describe("GET /usage", () => {
  it("el administrador ve a todos (también sin gasto); el corredor, solo el suyo", async () => {
    const s = await setup();
    // El mes de la corrida, así la prueba no depende del cambio de mes.
    const month = await s.spend(s.listing.id);

    const all = usageResponseSchema.parse(await (await s.admin(`/usage?month=${month}`)).json());
    expect(all.month).toBe(month);
    expect(all.brokers).toEqual(
      expect.arrayContaining([
        {
          brokerId: s.mine.id,
          slug: "mio",
          spentUsd: expect.closeTo(0.7, 10),
          capUsd: 0.5,
          runs: 1,
        },
        { brokerId: s.theirs.id, slug: "ajeno", spentUsd: 0, capUsd: null, runs: 0 },
      ]),
    );

    const own = usageResponseSchema.parse(await (await s.broker(`/usage?month=${month}`)).json());
    expect(own.brokers.map((row) => row.slug)).toEqual(["mio"]);
  });

  it("sin month, el mes de hoy en Chile", async () => {
    const s = await setup();
    const before = chileMonthOf(new Date());
    const body = usageResponseSchema.parse(await (await s.admin("/usage")).json());
    expect([before, chileMonthOf(new Date())]).toContain(body.month);
  });

  it("otro mes no trae el gasto de este; un mes mal escrito es 400", async () => {
    const s = await setup();
    await s.spend(s.listing.id);
    const other = usageResponseSchema.parse(await (await s.admin("/usage?month=2020-01")).json());
    expect(other.brokers.every((row) => row.spentUsd === 0 && row.runs === 0)).toBe(true);

    for (const month of ["2026-13", "octubre"]) {
      const response = await s.admin(`/usage?month=${month}`);
      expect(response.status).toBe(400);
    }
  });

  it("sin sesión es 401", async () => {
    const s = await setup();
    const response = await createApp(s.deps).request("/usage");
    expect(response.status).toBe(401);
  });
});

describe("POST /listings/:id/content-runs con el tope de IA alcanzado", () => {
  it("con textos es 409 LLM_BUDGET_EXCEEDED; solo imágenes, 202", async () => {
    const s = await setup();
    await s.spend(s.listing.id);

    const texts = await s.broker(`/listings/${s.listing.id}/content-runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(texts.status).toBe(409);
    expect(errorBodySchema.parse(await texts.json()).error.code).toBe("LLM_BUDGET_EXCEEDED");

    const images = await s.broker(`/listings/${s.listing.id}/content-runs`, {
      method: "POST",
      body: JSON.stringify({ texts: false }),
    });
    expect(images.status).toBe(202);
  });
});
