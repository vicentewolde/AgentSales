import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrokerData } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { cardStyleResponseSchema, errorBodySchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testDeps } from "../testing/index.js";

// F9.7 B4 (ADR-0043): el estilo de las imágenes por la API, con el de AgentPey del repositorio.

const ORIGIN = "http://localhost:5173";
const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: "agentpeyai",
  website: null,
  tone: null,
  fixedHashtags: [],
});

async function setup() {
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  const app = createApp(deps);
  const broker = await deps.brokers.create(brokerData("agentpey"));
  const call = (path: string, init: { method?: string; json?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        ...(init.method !== undefined && init.method !== "GET" ? { origin: ORIGIN } : {}),
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    });
  return { deps, broker, call };
}

const agentpey = async () =>
  JSON.parse(
    await readFile(
      join(import.meta.dirname, "../../../../docs/marca/agentpey/estilo.json"),
      "utf8",
    ),
  ) as unknown;

describe("/brokers/:id/card-style", () => {
  it("sin estilo devuelve null; guarda el de AgentPey sin avisos de contraste y sube la versión", async () => {
    const s = await setup();
    const empty = cardStyleResponseSchema.parse(
      await (await s.call(`/brokers/${s.broker.id}/card-style`)).json(),
    );
    expect(empty.cardStyle).toMatchObject({ style: null, version: null });
    const saved = await s.call(`/brokers/${s.broker.id}/card-style`, {
      method: "PUT",
      json: { style: await agentpey() },
    });
    expect(saved.status).toBe(200);
    const body = cardStyleResponseSchema.parse(await saved.json());
    expect(body.cardStyle.version).toBe(1);
    expect(body.cardStyle.style?.themes).toHaveLength(4);
    expect(body.cardStyle.warnings).toEqual([]);
  });

  it("un estilo inválido es 400 con su campo; la muestra devuelve un PNG", async () => {
    const s = await setup();
    const bad = await s.call(`/brokers/${s.broker.id}/card-style`, {
      method: "PUT",
      json: { style: { version: 1 } },
    });
    expect(bad.status).toBe(400);
    expect(errorBodySchema.parse(await bad.json()).error.code).toBe("CARD_STYLE_INVALID");
    const none = await s.call(`/brokers/${s.broker.id}/card-style/preview`, {
      method: "POST",
      json: {},
    });
    expect(none.status).toBe(404);
    const preview = await s.call(`/brokers/${s.broker.id}/card-style/preview`, {
      method: "POST",
      json: { style: await agentpey(), theme: 2, composition: "explain", format: "1:1" },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
  });
});
