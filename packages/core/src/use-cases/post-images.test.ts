import { describe, expect, it } from "vitest";
import type { BrokerData } from "../broker.js";
import type { PostKind } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { IMAGE_AI_BUDGET_MESSAGE, monthlyImageSpend } from "../image-ai-budget.js";
import type { PostImageRequest } from "../post-image.js";
import {
  createFakeCardRenderer,
  createFakeImageGenerator,
  createFakeStockPhotoProvider,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryJobQueue,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostImageRunRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
  fakeJpeg,
} from "../testing/index.js";
import { getPostImageOptions, requestPostImage, searchStockPhotos } from "./post-images.js";
import { runPostImage } from "./run-post-image.js";

// F9.5-T25 (ADR-0038): conseguir imágenes para un post. Pedirlas (API), conseguirlas (worker) con
// las tarjetas, la biblioteca y la IA falsas, guardarlas en el R2 falso y adjuntarlas como medios;
// y el gasto de la IA con su tope.

const ADMIN = { id: "admin-1", role: "admin" as const, brokerId: null };
const PRICING = { priceUsd: 0.04, monthlyCapUsd: 0.1 };

const brokerData: BrokerData = {
  slug: "agentpey",
  name: "Vinny",
  brandName: "AgentPey",
  primaryColor: "#123456",
  secondaryColor: "#abcdef",
  whatsapp: null,
  email: null,
  instagramHandle: "agentpey",
  website: null,
  tone: null,
  fixedHashtags: [],
};

const sha256 = (bytes: Uint8Array) =>
  Array.from(bytes.slice(0, 32), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

async function setup(
  options: { kind?: PostKind; stock?: boolean; ai?: boolean; body?: string } = {},
) {
  let clock = new Date("2026-10-20T15:00:00Z");
  const now = () => clock;
  const brokers = createInMemoryBrokerRepository();
  const broker = await brokers.create(brokerData, { kind: "brand" });
  const posts = createInMemoryPostRepository();
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const queue = createInMemoryJobQueue();
  const content = createInMemoryContentRepositories();
  const runs = createInMemoryPostImageRunRepository({ now });
  const postLock = createInMemoryPostLock({
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications: createInMemoryPublicationRepository(),
    platformAccounts: createInMemoryPlatformAccountRepository(),
  });
  const post = await posts.create({
    brokerId: broker.id,
    topic: "Cómo fijar el precio 🏡",
    kind: options.kind ?? "carousel",
  });
  const stock = options.stock === false ? null : createFakeStockPhotoProvider();
  const generator = createFakeImageGenerator({ model: "nano-test" });
  const cards = createFakeCardRenderer();
  const processor = createInMemoryMediaProcessor({ version: "1" });
  const body = options.body ?? "Tres claves:\n- Mira el mercado\n- Revisa los gastos";
  const api = {
    posts,
    brokers,
    runs,
    queue,
    sources: { stock, ai: options.ai === false ? null : PRICING },
    now,
  };
  const worker = {
    runs,
    posts,
    brokers,
    contents: {
      listCurrent: async () =>
        body === "" ? [] : [{ platform: "instagram" as const, body } as never],
    },
    media,
    storage,
    postLock,
    queue,
    cards,
    processor,
    stock,
    ai: options.ai === false ? null : { generator, pricing: PRICING },
    sha256,
    now,
  };
  const request = (input: PostImageRequest) => requestPostImage(api, ADMIN, post.id, input);
  const work = (runId: string, isLastAttempt = true) =>
    runPostImage(worker, { runId, isLastAttempt });
  return {
    api,
    worker,
    broker,
    brokers,
    post,
    posts,
    media,
    storage,
    queue,
    runs,
    cards,
    processor,
    generator,
    request,
    work,
    setClock: (date: Date) => {
      clock = date;
    },
  };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : String(error);
  }
  return "OK";
};

describe("requestPostImage", () => {
  it("deja el pedido en cola y encola post.image con su id", async () => {
    const s = await setup();
    const run = await s.request({ source: "card", format: "4:5" });
    expect(run).toMatchObject({ status: "queued", source: "card", createdBy: "admin-1" });
    expect(s.queue.jobs).toEqual([
      { name: "post.image", data: { postImageRunId: run.id }, options: { singletonKey: run.id } },
    ]);
  });

  it("un post de video pide sus tarjetas en 9:16 y no acepta una foto", async () => {
    const s = await setup({ kind: "video" });
    const run = await s.request({ source: "card", format: "4:5" });
    expect(run.request).toEqual({ source: "card", format: "9:16" });
    await s.runs.markFailed(run.id, { code: "X", message: "x" });
    expect(await codeOf(s.request({ source: "ai", prompt: "una casa", format: "9:16" }))).toBe(
      "POST_IMAGE_INVALID",
    );
  });

  it("un post de texto, uno archivado y un segundo pedido en curso se niegan", async () => {
    const text = await setup({ kind: "text" });
    expect(await codeOf(text.request({ source: "card", format: "4:5" }))).toBe(
      "POST_IMAGE_NOT_NEEDED",
    );
    const s = await setup();
    await s.request({ source: "card", format: "4:5" });
    expect(await codeOf(s.request({ source: "card", format: "4:5" }))).toBe(
      "POST_IMAGE_RUN_ACTIVE",
    );
    await s.posts.update(s.post.id, { status: "archived" });
    expect(await codeOf(s.request({ source: "card", format: "4:5" }))).toBe("POST_ARCHIVED");
  });

  it("sin claves, la biblioteca y la IA dicen qué falta; las tarjetas funcionan igual", async () => {
    const s = await setup({ stock: false, ai: false });
    const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
    expect(options.sources).toEqual({
      card: { available: true },
      stock: { available: false, missing: "PIXABAY_API_KEY" },
      ai: {
        available: false,
        missing: "GEMINI_API_KEY",
        priceUsd: null,
        capUsd: null,
        spentUsd: 0,
        capReached: false,
      },
    });
    expect(options.suggestions.query).toBe("Cómo fijar el precio 🏡");
    expect(
      await codeOf(s.request({ source: "stock", photoId: "1", query: "x", format: "4:5" })),
    ).toBe("POST_IMAGE_SOURCE_NOT_CONFIGURED");
    expect(await codeOf(s.request({ source: "ai", prompt: "una casa", format: "4:5" }))).toBe(
      "POST_IMAGE_SOURCE_NOT_CONFIGURED",
    );
    expect(await codeOf(s.request({ source: "card", format: "4:5" }))).toBe("OK");
  });

  it("si no se pudo encolar, el pedido queda failed", async () => {
    const s = await setup();
    s.api.queue = {
      enqueue: async () => {
        throw new Error("sin cola");
      },
    } as never;
    expect(await codeOf(s.request({ source: "card", format: "4:5" }))).toBe("QUEUE_UNAVAILABLE");
    expect(s.runs.all()[0]?.status).toBe("failed");
  });
});

describe("searchStockPhotos", () => {
  it("filtra las fotos con personas en sus etiquetas si se pide, hasta 12", async () => {
    const s = await setup();
    const photo = (id: string, tags: string[]) => ({
      id,
      previewUrl: `https://cdn.example/${id}.jpg`,
      pageUrl: `https://pixabay.example/${id}`,
      tags,
      width: 1280,
      height: 1600,
      author: "autor",
    });
    const stock = createFakeStockPhotoProvider({
      photos: [
        photo("1", ["casa", "living"]),
        photo("2", ["mujer", "casa"]),
        photo("3", ["people"]),
      ],
    });
    const deps = { ...s.api, sources: { stock, ai: null } };
    const all = await searchStockPhotos(deps, ADMIN, s.post.id, {
      text: " living ",
      withoutPeople: false,
    });
    expect(all.map((item) => item.id)).toEqual(["1", "2", "3"]);
    const clean = await searchStockPhotos(deps, ADMIN, s.post.id, {
      text: "living",
      withoutPeople: true,
    });
    expect(clean.map((item) => item.id)).toEqual(["1"]);
    expect(stock.searches).toEqual(["living", "living"]);
  });
});

describe("runPostImage", () => {
  it("tarjetas de un carrusel: quedan en R2 y como medios del post, en orden, y se encola post.media", async () => {
    const s = await setup();
    const run = await s.request({ source: "card", format: "4:5" });
    const result = await s.work(run.id);
    expect(result).toMatchObject({ outcome: "succeeded", created: 4 });
    expect(s.cards.calls.map((call) => [call.card.role, call.card.text, call.format])).toEqual([
      ["cover", "Cómo fijar el precio", "4:5"],
      ["point", "Mira el mercado", "4:5"],
      ["point", "Revisa los gastos", "4:5"],
      ["closing", "AgentPey", "4:5"],
    ]);
    const originals = await s.media.listOriginals({ kind: "post", id: s.post.id });
    expect(originals.map((item) => [item.kind, item.mime, item.sortOrder])).toEqual([
      ["image", "image/jpeg", 0],
      ["image", "image/jpeg", 1],
      ["image", "image/jpeg", 2],
      ["image", "image/jpeg", 3],
    ]);
    for (const item of originals) {
      expect(item.storagePath).toBe(`posts/${s.post.id}/original/${item.checksum}.jpg`);
      expect(await s.storage.head(item.storagePath)).not.toBeNull();
    }
    expect(s.queue.jobs.at(-1)).toEqual({
      name: "post.media",
      data: { postId: s.post.id },
      options: { singletonKey: s.post.id },
    });
    const done = await s.runs.get(run.id);
    expect(done).toMatchObject({ status: "succeeded", costUsd: null });
    expect(done?.mediaIds).toEqual(originals.map((item) => item.id));
  });

  it("repetir las mismas tarjetas no duplica los medios", async () => {
    const s = await setup({ kind: "image" });
    await s.work((await s.request({ source: "card", format: "9:16" })).id);
    const second = await s.work((await s.request({ source: "card", format: "9:16" })).id);
    expect(second).toMatchObject({ outcome: "succeeded", created: 0 });
    expect(await s.media.listOriginals({ kind: "post", id: s.post.id })).toHaveLength(1);
  });

  it("video: las tarjetas en 9:16 se unen con el motor del reel desde fotos y queda un video", async () => {
    const s = await setup({ kind: "video" });
    const result = await s.work((await s.request({ source: "card", format: "9:16" })).id);
    expect(result).toMatchObject({ outcome: "succeeded", created: 1 });
    expect(s.processor.calls).toEqual([
      expect.objectContaining({ kind: "photoReel", photos: 4, overlay: false, music: null }),
    ]);
    const [video] = await s.media.listOriginals({ kind: "post", id: s.post.id });
    expect(video).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(video?.storagePath.endsWith(".mp4")).toBe(true);
  });

  it("video sin texto redactado: el pedido falla con el motivo, sin medios", async () => {
    const s = await setup({ kind: "video", body: "" });
    const run = await s.request({ source: "card", format: "9:16" });
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "POST_IMAGE_NEEDS_TEXT" });
    expect((await s.runs.get(run.id))?.error?.code).toBe("POST_IMAGE_NEEDS_TEXT");
    expect(await s.media.listOriginals({ kind: "post", id: s.post.id })).toEqual([]);
  });

  it("biblioteca: descarga por id, revisa que sea una imagen y la adjunta", async () => {
    const s = await setup();
    const run = await s.request({
      source: "stock",
      photoId: "123",
      query: "living",
      format: "4:5",
    });
    expect(await s.work(run.id)).toMatchObject({ outcome: "succeeded", created: 1 });
    const [photo] = await s.media.listOriginals({ kind: "post", id: s.post.id });
    expect(photo).toMatchObject({ kind: "image", mime: "image/jpeg" });
  });

  it("biblioteca: un archivo que no es imagen no se guarda", async () => {
    const s = await setup();
    s.worker.stock = createFakeStockPhotoProvider({
      file: { bytes: Uint8Array.from([60, 104, 116, 109, 108]), mime: "image/jpeg" },
    });
    const run = await s.request({ source: "stock", photoId: "9", query: "x", format: "4:5" });
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "STOCK_DOWNLOAD_INVALID" });
    expect(s.storage.uploads).toEqual([]);
  });

  it("IA: la indicación lleva las reglas, el costo se anota con el modelo y la imagen se adjunta", async () => {
    const s = await setup();
    const run = await s.request({ source: "ai", prompt: "Un living luminoso", format: "9:16" });
    expect(await s.work(run.id)).toMatchObject({ outcome: "succeeded", created: 1 });
    expect(s.generator.prompts).toEqual([
      { prompt: expect.stringMatching(/^Un living luminoso\n\nSin texto/u), format: "9:16" },
    ]);
    expect(await s.runs.get(run.id)).toMatchObject({ costUsd: 0.04, model: "nano-test" });
  });

  it("IA: un error reintentable sube antes del último intento; en el último, falla", async () => {
    const s = await setup();
    s.worker.ai = {
      generator: createFakeImageGenerator({
        error: new AppError("IMAGE_AI_UNAVAILABLE", "caída", { retriable: true }),
      }),
      pricing: PRICING,
    };
    const run = await s.request({ source: "ai", prompt: "Un living", format: "4:5" });
    expect(await codeOf(s.work(run.id, false))).toBe("IMAGE_AI_UNAVAILABLE");
    expect((await s.runs.get(run.id))?.status).toBe("running");
    expect(await s.work(run.id, true)).toEqual({ outcome: "failed", code: "IMAGE_AI_UNAVAILABLE" });
  });
});

describe("el gasto de la IA", () => {
  it("se anota por marca, el tope no se pasa y se niega con el mensaje simple", async () => {
    const s = await setup();
    for (const prompt of ["uno", "dos"]) {
      const run = await s.request({ source: "ai", prompt: `Imagen ${prompt}`, format: "4:5" });
      await s.work(run.id);
    }
    // 0,08 gastado: una tercera (0,12) pasaría el tope de 0,10.
    let error: unknown;
    try {
      await s.request({ source: "ai", prompt: "Imagen tres", format: "4:5" });
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error) && error.code).toBe("IMAGE_AI_BUDGET_EXCEEDED");
    expect(isAppError(error) && error.message.startsWith(IMAGE_AI_BUDGET_MESSAGE)).toBe(true);
    const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
    expect(options.sources.ai).toMatchObject({ spentUsd: 0.08, capReached: true });

    // El worker vuelve a revisar: un pedido que entró antes del tope no lo pasa.
    const spend = await monthlyImageSpend(
      { runs: s.runs, brokers: s.brokers },
      { month: "2026-10", scope: { kind: "all" }, pricing: PRICING },
    );
    expect(spend).toEqual([
      {
        brokerId: s.broker.id,
        slug: "agentpey",
        spentUsd: 0.08,
        images: 2,
        capUsd: 0.1,
        capReached: true,
      },
    ]);

    // El mes siguiente vuelve a haber cupo (mes de Chile).
    s.setClock(new Date("2026-11-02T15:00:00Z"));
    expect(await codeOf(s.request({ source: "ai", prompt: "Imagen nueva", format: "4:5" }))).toBe(
      "OK",
    );
  });

  it("el worker se niega si el tope se alcanzó después de pedir", async () => {
    const s = await setup();
    const run = await s.request({ source: "ai", prompt: "Una casa", format: "4:5" });
    await s.runs.recordCost(run.id, { costUsd: 0.09, model: "otro" });
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "IMAGE_AI_BUDGET_EXCEEDED" });
    expect(s.generator.prompts).toEqual([]);
    expect(fakeJpeg("x")[0]).toBe(0xff);
  });
});
