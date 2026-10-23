import type { BrokerData } from "@agentsales/core";
import {
  createFakeStockPhotoProvider,
  createInMemoryJobQueue,
  createInMemoryPostImageRunRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  errorBodySchema,
  postImageCardsRemovedResponseSchema,
  postImageOptionsResponseSchema,
  postImageRunResponseSchema,
  postImageStockResponseSchema,
  usageResponseSchema,
} from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9.5-T25 (ADR-0038): las rutas para conseguir imágenes de un post. La API pide y busca; el worker
// consigue (`post.image`). Sin claves, solo las tarjetas.

const ORIGIN = "http://localhost:5173";
const OTHER = "token-de-otra-marca";

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#445566",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

async function setup(options: { stock?: boolean; ai?: boolean } = {}) {
  const auth = testAuth();
  const queue = createInMemoryJobQueue();
  const postImageRuns = createInMemoryPostImageRunRepository();
  const stock = createFakeStockPhotoProvider({
    photos: [
      {
        id: "11",
        previewUrl: "https://pixabay.com/get/11_640.jpg",
        pageUrl: "https://pixabay.com/photos/11/",
        tags: ["casa"],
        width: 1280,
        height: 1600,
        author: "a",
      },
      {
        id: "12",
        previewUrl: "https://pixabay.com/get/12_640.jpg",
        pageUrl: "https://pixabay.com/photos/12/",
        tags: ["mujer", "casa"],
        width: 1280,
        height: 1600,
        author: "b",
      },
    ],
  });
  const deps = testDeps({
    access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] },
    queue,
    postImageRuns,
    imageSources: {
      stock: options.stock === true ? stock : null,
      ai: options.ai === true ? { priceUsd: 0.04, monthlyCapUsd: 0.05 } : null,
    },
    imageAiPricing: { priceUsd: 0.04, monthlyCapUsd: 0.05 },
  });
  deps.auth = { ...auth, brokers: deps.brokers };
  const app = createApp(deps);
  const brand = await deps.brokers.create(brokerData("marca"), { kind: "brand" });
  const other = await deps.brokers.create(brokerData("otra"), { kind: "brand" });
  const post = await deps.posts.create({
    brokerId: brand.id,
    topic: "Cómo vender",
    kind: "carousel",
  });
  const user = auth.repos.seed.user({
    email: "otra@ejemplo.cl",
    name: "Otra",
    role: "broker",
    brokerId: other.id,
  });
  auth.repos.seed.session({ userId: user.id, tokenHash: auth.tokens.hash(OTHER), client: "panel" });
  const as =
    (token: string) =>
    (path: string, init: { method?: string; body?: unknown } = {}) =>
      app.request(path, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.method === undefined || init.method === "GET"
            ? {}
            : { origin: ORIGIN, "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
  return {
    deps,
    queue,
    postImageRuns,
    stock,
    brand,
    post,
    admin: as(TEST_ADMIN_TOKEN),
    other: as(OTHER),
  };
}

const codeOf = async (response: Response) =>
  errorBodySchema.parse(await response.json()).error.code;

describe("/posts/:id/images", () => {
  it("sin claves: las fuentes dicen qué falta, las tarjetas se piden y la biblioteca se niega", async () => {
    const s = await setup();
    const options = postImageOptionsResponseSchema.parse(
      await (await s.admin(`/posts/${s.post.id}/images`)).json(),
    );
    expect(options.sources.stock).toEqual({ available: false, missing: "PIXABAY_API_KEY" });
    expect(options.sources.ai).toMatchObject({ available: false, missing: "GEMINI_API_KEY" });
    expect(options.suggestions.query).toBe("Cómo vender");

    const created = await s.admin(`/posts/${s.post.id}/images`, {
      method: "POST",
      body: { source: "card", format: "4:5" },
    });
    expect(created.status).toBe(202);
    const { run } = postImageRunResponseSchema.parse(await created.json());
    expect(run).toMatchObject({ source: "card", status: "queued", postId: s.post.id });
    expect(s.queue.jobs).toEqual([
      { name: "post.image", data: { postImageRunId: run.id }, options: { singletonKey: run.id } },
    ]);
    const again = await s.admin(`/posts/${s.post.id}/images`, {
      method: "POST",
      body: { source: "card", format: "4:5" },
    });
    expect([again.status, await codeOf(again)]).toEqual([409, "POST_IMAGE_RUN_ACTIVE"]);

    const followed = postImageRunResponseSchema.parse(
      await (await s.admin(`/posts/${s.post.id}/images/${run.id}`)).json(),
    );
    expect(followed.run.id).toBe(run.id);

    const stock = await s.admin(`/posts/${s.post.id}/images/stock?q=casa`);
    expect([stock.status, await codeOf(stock)]).toEqual([503, "POST_IMAGE_SOURCE_NOT_CONFIGURED"]);
  });

  it("con la biblioteca: busca sin personas por defecto; con people=1, todas", async () => {
    const s = await setup({ stock: true });
    const clean = postImageStockResponseSchema.parse(
      await (await s.admin(`/posts/${s.post.id}/images/stock?q=casa`)).json(),
    );
    expect(clean.photos.map((photo) => photo.id)).toEqual(["11"]);
    const all = postImageStockResponseSchema.parse(
      await (await s.admin(`/posts/${s.post.id}/images/stock?q=casa&people=1`)).json(),
    );
    expect(all.photos.map((photo) => photo.id)).toEqual(["11", "12"]);
    const empty = await s.admin(`/posts/${s.post.id}/images/stock?q=`);
    expect(empty.status).toBe(400);
  });

  it("la IA en el tope del mes se niega con 409 y el mensaje simple; /usage lo muestra aparte", async () => {
    const s = await setup({ ai: true });
    const first = postImageRunResponseSchema.parse(
      await (
        await s.admin(`/posts/${s.post.id}/images`, {
          method: "POST",
          body: { source: "ai", prompt: "Un living luminoso", format: "4:5" },
        })
      ).json(),
    );
    await s.postImageRuns.reserveImageCost(first.run.id, {
      costUsd: 0.04,
      model: "nano",
      capUsd: 1,
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01"),
    });
    await s.postImageRuns.markFailed(first.run.id, { code: "X", message: "x" });
    const refused = await s.admin(`/posts/${s.post.id}/images`, {
      method: "POST",
      body: { source: "ai", prompt: "Otra imagen", format: "4:5" },
    });
    expect(refused.status).toBe(409);
    const body = errorBodySchema.parse(await refused.json());
    expect(body.error.code).toBe("IMAGE_AI_BUDGET_EXCEEDED");
    expect(body.error.message).toMatch(/^Llegaste al tope de imágenes con IA de este mes/u);

    const usage = usageResponseSchema.parse(await (await s.admin("/usage")).json());
    expect(usage.images.find((row) => row.brokerId === s.brand.id)).toEqual({
      brokerId: s.brand.id,
      slug: "marca",
      spentUsd: 0.04,
      images: 1,
      capUsd: 0.05,
      capReached: true,
    });
  });

  it("las opciones dicen cuántas tarjetas saldrán; DELETE /images/cards quita solo las tarjetas del post", async () => {
    const s = await setup();
    const options = postImageOptionsResponseSchema.parse(
      await (await s.admin(`/posts/${s.post.id}/images`)).json(),
    );
    expect(options.cards).toEqual({
      count: 2,
      existing: 0,
      message: "2 tarjetas: portada y cierre.",
    });

    // Una foto que subió el usuario y dos tarjetas de un pedido terminado.
    const media = (checksum: string, sortOrder: number) =>
      s.deps.media.create({
        listingId: null,
        postId: s.post.id,
        brokerId: s.brand.id,
        kind: "image",
        storagePath: `posts/${s.post.id}/original/${checksum}.jpg`,
        mime: "image/jpeg",
        bytes: 10,
        checksum,
        sortOrder,
        isCover: false,
      });
    const upload = await media("u".repeat(64), 0);
    const cards = [await media("c".repeat(64), 1), await media("d".repeat(64), 2)];
    const run = await s.postImageRuns.create({
      postId: s.post.id,
      brokerId: s.brand.id,
      source: "card",
      request: { source: "card", format: "4:5" },
      createdBy: null,
    });
    await s.postImageRuns.markRunning(run.id);
    await s.postImageRuns.markSucceeded(
      run.id,
      cards.map((card) => card.id),
    );
    const withCards = postImageOptionsResponseSchema.parse(
      await (await s.admin(`/posts/${s.post.id}/images`)).json(),
    );
    expect(withCards.cards?.existing).toBe(2);

    // Lo de otra marca es 404 y no borra nada.
    const foreign = await s.other(`/posts/${s.post.id}/images/cards`, { method: "DELETE" });
    expect(foreign.status).toBe(404);
    expect(await s.deps.media.listOriginals({ kind: "post", id: s.post.id })).toHaveLength(3);

    const removed = await s.admin(`/posts/${s.post.id}/images/cards`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(postImageCardsRemovedResponseSchema.parse(await removed.json())).toEqual({
      removed: 2,
      leftover: 0,
    });
    expect(
      (await s.deps.media.listOriginals({ kind: "post", id: s.post.id })).map((item) => item.id),
    ).toEqual([upload.id]);
  });

  it("lo de otra marca es 404; un pedido inválido es 400", async () => {
    const s = await setup();
    expect((await s.other(`/posts/${s.post.id}/images`)).status).toBe(404);
    const invalid = await s.admin(`/posts/${s.post.id}/images`, {
      method: "POST",
      body: { source: "stock", photoId: "https://malo.example/x.jpg", query: "x", format: "4:5" },
    });
    expect(invalid.status).toBe(400);
  });
});
