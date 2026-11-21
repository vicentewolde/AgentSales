import type { BrokerData } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { errorBodySchema, postCardTextsResponseSchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testDeps } from "../testing/index.js";

// F9.7 B5 y B7: los textos de las láminas de un post y su PDF para LinkedIn, por la API.

const ORIGIN = "http://localhost:5173";
const brokerData: BrokerData = {
  slug: "agentpey",
  name: "Persona",
  brandName: "AgentPey",
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
};

async function setup(kind: "carousel" | "text" | "image" = "carousel") {
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  const app = createApp(deps);
  const broker = await deps.brokers.create(brokerData, { kind: "brand" });
  const post = await deps.posts.create({ brokerId: broker.id, topic: "Tema", kind });
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
  return { deps, post, call };
}

describe("/posts/:id/card-texts", () => {
  it("el operador edita las láminas de un idioma y vuelven con su revisión", async () => {
    const s = await setup();
    const saved = await s.call(`/posts/${s.post.id}/card-texts/es`, {
      method: "PUT",
      json: {
        texts: [{ headline: "Portada con 9.999 clientes", subtitle: "Sub" }, { headline: "Punto" }],
      },
    });
    expect(saved.status).toBe(200);
    const body = postCardTextsResponseSchema.parse(await saved.json());
    expect(body.texts.map((text) => [text.role, text.headline, text.approved])).toEqual([
      ["cover", "Portada con 9.999 clientes", true],
      ["point", "Punto", true],
    ]);
    expect(body.texts[0]?.checks.map((check) => check.code)).toContain("FACT_NOT_IN_PROFILE");
    const english = await s.call(`/posts/${s.post.id}/card-texts/en`, {
      method: "PUT",
      json: { texts: [{ headline: "Cover" }] },
    });
    expect(english.status).toBe(409);
  });

  it("un post de imagen guarda su portada y hasta 3 puntos clave", async () => {
    const s = await setup("image");
    const saved = await s.call(`/posts/${s.post.id}/card-texts/es`, {
      method: "PUT",
      json: {
        texts: [
          { headline: "Cómo compran con IA" },
          { headline: "Uno" },
          { headline: "Dos" },
          { headline: "Tres" },
          { headline: "Cuatro" },
        ],
      },
    });
    expect(saved.status).toBe(200);
    const body = postCardTextsResponseSchema.parse(await saved.json());
    expect(body.texts.map((text) => [text.role, text.headline])).toEqual([
      ["cover", "Cómo compran con IA"],
      ["point", "Uno"],
      ["point", "Dos"],
      ["point", "Tres"],
    ]);
  });

  it("un post de texto no tiene láminas; el PDF sin imágenes es 409", async () => {
    const text = await setup("text");
    const response = await text.call(`/posts/${text.post.id}/card-texts/es`, {
      method: "PUT",
      json: { texts: [{ headline: "x" }] },
    });
    expect(response.status).toBe(409);
    const s = await setup();
    const pdf = await s.call(`/posts/${s.post.id}/linkedin-pdf?language=es`);
    expect(pdf.status).toBe(409);
    expect(errorBodySchema.parse(await pdf.json()).error.code).toBe("POST_PDF_NO_IMAGES");
  });
});
