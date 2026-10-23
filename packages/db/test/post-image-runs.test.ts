import type { PostImageRunRepository } from "@agentsales/core";
import { createInMemoryPostImageRunRepository } from "@agentsales/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRepository } from "../src/repositories/brokers.js";
import { createPostImageRunRepository } from "../src/repositories/post-image-runs.js";
import { createPostRepository } from "../src/repositories/posts.js";
import { createTestDatabase, type TestDatabase } from "./pglite.js";

// F9.5-T25 (ADR-0038): los pedidos de imágenes de un post, iguales contra el doble en memoria y
// contra Drizzle sobre PGlite (con la migración 0020).

type Setup = {
  repository: PostImageRunRepository;
  /** Un post nuevo de una marca (cada prueba usa los suyos). */
  newPost: (brokerId?: string) => Promise<{ postId: string; brokerId: string }>;
};

const BROKER = {
  name: "Vinny",
  primaryColor: "#123456",
  secondaryColor: "#abcdef",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
};

function postImageRunContract(name: string, make: () => Promise<Setup>) {
  describe(`${name} · PostImageRunRepository`, () => {
    let s: Setup;
    beforeAll(async () => {
      s = await make();
    });

    it("crea en cola, uno activo por post, y cambia de estado solo desde el que corresponde", async () => {
      const { postId, brokerId } = await s.newPost();
      const run = await s.repository.create({
        postId,
        brokerId,
        source: "card",
        request: { source: "card", format: "4:5" },
        createdBy: null,
      });
      expect(run).toMatchObject({
        postId,
        brokerId,
        source: "card",
        status: "queued",
        request: { source: "card", format: "4:5" },
        mediaIds: [],
        costUsd: null,
        error: null,
      });
      await expect(
        s.repository.create({
          postId,
          brokerId,
          source: "card",
          request: { source: "card", format: "9:16" },
          createdBy: null,
        }),
      ).rejects.toMatchObject({ code: "POST_IMAGE_RUN_ACTIVE" });

      expect(await s.repository.markSucceeded(run.id, [])).toBe(false);
      expect(await s.repository.markRunning(run.id)).toBe(true);
      expect(await s.repository.markRunning(run.id)).toBe(true);
      const mediaId = "11111111-1111-4111-8111-111111111111";
      expect(await s.repository.markSucceeded(run.id, [mediaId])).toBe(true);
      expect(await s.repository.markFailed(run.id, { code: "X", message: "x" })).toBe(false);
      expect(await s.repository.get(run.id)).toMatchObject({
        status: "succeeded",
        mediaIds: [mediaId],
      });
      // Terminado el anterior, se puede pedir otro.
      const next = await s.repository.create({
        postId,
        brokerId,
        source: "stock",
        request: { source: "stock", photoId: "42", query: "living", format: "4:5" },
        createdBy: null,
      });
      expect(
        await s.repository.markFailed(next.id, { code: "STOCK_RATE_LIMITED", message: "m" }),
      ).toBe(true);
      expect((await s.repository.listByPost(postId, 5)).map((item) => item.id)).toEqual([
        next.id,
        run.id,
      ]);
    });

    it("reserva el costo solo si cabe en el tope de la marca, lo devuelve y lo suma por rango", async () => {
      const a = await s.newPost();
      const b = await s.newPost();
      const ai = (postId: string, brokerId: string) =>
        s.repository.create({
          postId,
          brokerId,
          source: "ai",
          request: { source: "ai", prompt: "una casa", format: "4:5" },
          createdBy: null,
        });
      const range = { from: new Date("2000-01-01"), to: new Date("2100-01-01") };
      const reserve = (id: string, costUsd: number, model = "nano") =>
        s.repository.reserveImageCost(id, { costUsd, model, capUsd: 0.1, ...range });
      const first = await ai(a.postId, a.brokerId);
      expect(await reserve(first.id, 0.034)).toBe(true);
      expect(await reserve(first.id, 0.034)).toBe(true);
      await s.repository.markFailed(first.id, { code: "X", message: "x" });
      const second = await ai(a.postId, a.brokerId);
      // 0,068 + 0,05 pasa el tope de 0,10: no anota nada.
      expect(await reserve(second.id, 0.05, "nano-2")).toBe(false);
      expect(await s.repository.get(second.id)).toMatchObject({ costUsd: null, model: null });
      expect(await reserve(second.id, 0.032, "nano-2")).toBe(true);
      expect(await s.repository.get(second.id)).toMatchObject({ costUsd: 0.032, model: "nano-2" });
      // Otra marca tiene su propio tope.
      const other = await ai(b.postId, b.brokerId);
      expect(await reserve(other.id, 0.05)).toBe(true);
      await s.repository.releaseImageCost(other.id, 0.05);
      expect((await s.repository.get(other.id))?.costUsd).toBeNull();

      const [spend] = await s.repository.sumImageCost({ ...range, brokerId: a.brokerId });
      expect(spend?.images).toBe(2);
      expect(spend?.costUsd).toBeCloseTo(0.1, 6);
      expect(await s.repository.sumImageCost({ ...range, brokerId: b.brokerId })).toEqual([]);
      expect(
        await s.repository.sumImageCost({
          from: new Date("2000-01-01"),
          to: new Date("2000-02-01"),
          brokerId: a.brokerId,
        }),
      ).toEqual([]);
    });

    it("lista los que esperan en cola y cierra los abandonados en running", async () => {
      const { postId, brokerId } = await s.newPost();
      const run = await s.repository.create({
        postId,
        brokerId,
        source: "card",
        request: { source: "card", format: "4:5" },
        createdBy: null,
      });
      expect((await s.repository.listQueued()).map((item) => item.id)).toContain(run.id);
      await s.repository.markRunning(run.id);
      expect((await s.repository.listQueued()).map((item) => item.id)).not.toContain(run.id);
      // Empezó hace un momento: con un corte en el pasado no es abandonado.
      expect(
        await s.repository.failAbandoned(new Date("2000-01-01"), { code: "A", message: "a" }),
      ).not.toContain(run.id);
      const closed = await s.repository.failAbandoned(new Date("2100-01-01"), {
        code: "POST_IMAGE_RUN_ABANDONED",
        message: "m",
      });
      expect(closed).toContain(run.id);
      expect(await s.repository.get(run.id)).toMatchObject({
        status: "failed",
        error: { code: "POST_IMAGE_RUN_ABANDONED", message: "m" },
      });
    });
  });
}

let sequence = 0;
postImageRunContract("en memoria", async () => ({
  repository: createInMemoryPostImageRunRepository(),
  newPost: async () => {
    sequence += 1;
    return { postId: `post-${sequence}`, brokerId: `broker-${sequence}` };
  },
}));

let database: TestDatabase;
afterAll(async () => {
  await database?.close();
});
postImageRunContract("Drizzle", async () => {
  database = await createTestDatabase();
  const brokers = createBrokerRepository(database.db);
  const posts = createPostRepository(database.db);
  let n = 0;
  return {
    repository: createPostImageRunRepository(database.db),
    newPost: async () => {
      n += 1;
      const broker = await brokers.create(
        { ...BROKER, slug: `marca-${n}`, brandName: `Marca ${n}` },
        { kind: "brand" },
      );
      const post = await posts.create({ brokerId: broker.id, topic: "Tema", kind: "image" });
      return { postId: post.id, brokerId: broker.id };
    },
  };
});
