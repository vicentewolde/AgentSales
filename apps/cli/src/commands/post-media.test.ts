import {
  createFakeStockPhotoProvider,
  createInMemoryPostImageRunRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { brokerData, fakeClock, harness } from "../../test/harness.js";
import { runPostMedia } from "./post-media.js";
import { runUsage } from "./usage.js";

// F9.5-T25 (ADR-0038): `agentsales post media` contra la API real en proceso, con el worker de
// mentira (cada espera cierra el pedido) y la biblioteca falsa. Ninguna URL firmada se imprime.

const PHOTO = (id: string, tags: string[]) => ({
  id,
  previewUrl: `https://pixabay.com/get/${id}_640.jpg?firma=secreta`,
  pageUrl: `https://pixabay.com/photos/${id}/`,
  tags,
  width: 1280,
  height: 1600,
  author: "autora",
});

async function setup(options: { keys?: boolean; worker?: "ok" | "fail" } = {}) {
  const postImageRuns = createInMemoryPostImageRunRepository();
  const stock = createFakeStockPhotoProvider({
    photos: [PHOTO("101", ["casa", "living"]), PHOTO("102", ["mujer"]), PHOTO("103", ["cocina"])],
  });
  const h = harness({
    deps: {
      postImageRuns,
      imageSources:
        options.keys === true
          ? { stock, ai: { priceUsd: 0.04, monthlyCapUsd: 2 } }
          : { stock: null, ai: null },
      imageAiPricing: { priceUsd: 0.04, monthlyCapUsd: 2 },
    },
  });
  const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  const post = await h.posts.create({ brokerId: brand.id, topic: "Cómo vender", kind: "image" });
  // El worker: cada espera atiende los pedidos en cola.
  const clock = fakeClock(async () => {
    for (const run of await postImageRuns.listByPost(post.id, 10)) {
      if (run.status !== "queued") continue;
      await postImageRuns.markRunning(run.id);
      if (options.worker === "fail") {
        await postImageRuns.markFailed(run.id, {
          code: "STOCK_RATE_LIMITED",
          message: "La biblioteca de fotos recibió demasiadas búsquedas: espera un minuto",
        });
        continue;
      }
      if (run.source === "ai")
        await postImageRuns.recordCost(run.id, { costUsd: 0.04, model: "nano" });
      await postImageRuns.markSucceeded(run.id, ["11111111-1111-4111-8111-111111111111"]);
    }
  });
  const deps = { ...h.io, client: h.client, sleep: clock.sleep, now: clock.now };
  return { h, deps, post, stock, postImageRuns };
}

describe("agentsales post media", () => {
  it("sin fuente muestra lo que hay; sin claves, dice qué falta", async () => {
    const s = await setup();
    await expect(runPostMedia(s.deps, s.post.id)).resolves.toBe(0);
    const text = s.h.text();
    expect(text).toContain("--card");
    expect(text).toContain("falta PIXABAY_API_KEY en el servidor");
    expect(text).toContain("falta GEMINI_API_KEY en el servidor");
  });

  it("--card pide las tarjetas, espera y dice cuántos medios quedaron", async () => {
    const s = await setup();
    await expect(runPostMedia(s.deps, s.post.id, { card: true, format: "9:16" })).resolves.toBe(0);
    expect(s.h.text()).toContain("Listo: 1 medio quedó en el post (tarjetas)");
    const [run] = await s.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({ source: "card", format: "9:16" });
    expect(s.h.queue.jobs.at(-1)?.name).toBe("post.image");
  });

  it("--stock lista los resultados sin personas y sin URLs firmadas; --pick elige uno", async () => {
    const s = await setup({ keys: true });
    await expect(runPostMedia(s.deps, s.post.id, { stock: "living" })).resolves.toBe(0);
    const listed = s.h.text();
    expect(listed).toMatch(/1\. 1280×1600 · casa, living · de autora/u);
    expect(listed).not.toContain("102");
    expect(listed).not.toContain("firma=secreta");
    await expect(runPostMedia(s.deps, s.post.id, { stock: "living", pick: "2" })).resolves.toBe(0);
    const [run] = await s.postImageRuns.listByPost(s.post.id, 1);
    expect(run?.request).toEqual({
      source: "stock",
      photoId: "103",
      query: "living",
      format: "4:5",
    });
    await expect(runPostMedia(s.deps, s.post.id, { stock: "living", pick: "9" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("--pick debe ser un número del 1 al 2");
  });

  it("--ai anota el costo; un pedido que falla sale con 1 y el motivo en simple", async () => {
    const s = await setup({ keys: true });
    await expect(runPostMedia(s.deps, s.post.id, { ai: "Un living luminoso" })).resolves.toBe(0);
    expect(s.h.text()).toContain("Costo: US$ 0,04 (nano)");
    const failing = await setup({ keys: true, worker: "fail" });
    await expect(runPostMedia(failing.deps, failing.post.id, { card: true })).resolves.toBe(1);
    expect(failing.h.errors()).toContain("No se consiguió: La biblioteca de fotos recibió");

    // `usage` lo muestra aparte del texto.
    await expect(runUsage({ ...s.h.io, client: s.h.client })).resolves.toBe(0);
    expect(s.h.text()).toContain("Imágenes con IA");
    expect(s.h.text()).toMatch(/agentpey\s+US\$ 0,04\s+US\$ 2,00\s+1/u);
  });

  it("dos fuentes a la vez o --pick sin --stock: el motivo, sin llamar", async () => {
    const s = await setup();
    await expect(runPostMedia(s.deps, s.post.id, { card: true, ai: "x" })).resolves.toBe(1);
    await expect(runPostMedia(s.deps, s.post.id, { pick: "1" })).resolves.toBe(1);
    await expect(runPostMedia(s.deps, s.post.id, { card: true, format: "1:1" })).resolves.toBe(1);
    expect(s.h.requests.filter((request) => request.includes("/images"))).toEqual([]);
  });
});
