import { describe, expect, it } from "vitest";
import type { BrokerData } from "../broker.js";
import { emptyEditorialProfileData } from "../editorial-profile.js";
import type { Language, PostKind, PostPlatform, PublicationStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  IMAGE_AI_BUDGET_MESSAGE,
  IMAGE_AI_NOT_CHARGED,
  monthlyImageSpend,
} from "../image-ai-budget.js";
import { cardLanguagesOf, mediaForLanguage } from "../post-card-languages.js";
import type { PostImageRequest } from "../post-image.js";
import {
  createFakeCardRenderer,
  createFakeImageGenerator,
  createFakeStockPhotoProvider,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
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
import { getPostContent } from "./get-post-content.js";
import {
  getPostImageOptions,
  getPostImageRun,
  removePostCards,
  requestPostImage,
  searchStockPhotos,
} from "./post-images.js";
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

type Text = { platform: PostPlatform; language: Language; body: string };

async function setup(
  options: {
    kind?: PostKind;
    stock?: boolean;
    ai?: boolean;
    body?: string;
    /** Los textos vigentes del post; por defecto uno de Instagram en español con `body`. */
    texts?: Text[];
    /** Las redes que fijó el post (`null`: todas). */
    platforms?: PostPlatform[];
    languages?: Language[];
  } = {},
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
  const publications = createInMemoryPublicationRepository();
  const postLock = createInMemoryPostLock({
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns: content.contentRuns,
    contents: content.contents,
    publications,
    platformAccounts: createInMemoryPlatformAccountRepository(),
  });
  const post = await posts.create({
    brokerId: broker.id,
    topic: "Cómo fijar el precio 🏡",
    kind: options.kind ?? "carousel",
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  });
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  if (options.languages !== undefined) {
    await editorialProfiles.upsert(broker.id, {
      ...emptyEditorialProfileData(),
      languages: options.languages,
    });
  }
  const stock = options.stock === false ? null : createFakeStockPhotoProvider();
  const generator = createFakeImageGenerator({ model: "nano-test" });
  const cards = createFakeCardRenderer();
  const processor = createInMemoryMediaProcessor({ version: "1" });
  // Solo viñetas: sin una primera oración que sirva de título, la portada usa el tema del post.
  const body = options.body ?? "- Mira el mercado\n- Revisa los gastos";
  const texts: Text[] =
    options.texts ?? (body === "" ? [] : [{ platform: "instagram", language: "es", body }]);
  const contents = { listCurrent: async () => texts as never };
  const api = {
    posts,
    brokers,
    contents,
    editorialProfiles,
    media,
    runs,
    queue,
    sources: { stock, ai: options.ai === false ? null : PRICING },
    postLock,
    storage,
    now,
  };
  const worker = {
    runs,
    posts,
    brokers,
    contents,
    editorialProfiles,
    media,
    storage,
    postLock,
    queue,
    cards,
    processor,
    stock,
    ai: options.ai === false ? null : { generator, model: "nano-test", pricing: PRICING },
    sha256,
    now,
  };
  const request = (input: PostImageRequest) => requestPostImage(api, ADMIN, post.id, input);
  const work = (runId: string, isLastAttempt = true) =>
    runPostImage(worker, { runId, isLastAttempt });
  return {
    api,
    worker,
    publications,
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
    expect(run.request).toEqual({ source: "card", format: "9:16", language: "es" });
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

describe("getPostImageRun", () => {
  it("devuelve el pedido solo si es de ese post", async () => {
    const s = await setup();
    const run = await s.request({ source: "card", format: "4:5" });
    expect((await getPostImageRun(s.api, ADMIN, s.post.id, run.id)).id).toBe(run.id);
    const other = await s.posts.create({ brokerId: s.broker.id, topic: "Otro", kind: "image" });
    expect(await codeOf(getPostImageRun(s.api, ADMIN, other.id, run.id))).toBe(
      "POST_IMAGE_RUN_NOT_FOUND",
    );
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

  it("IA: una caída o un corte después de llamar no se reintenta y queda cobrado", async () => {
    const s = await setup();
    const generator = createFakeImageGenerator({
      error: new AppError("IMAGE_AI_UNAVAILABLE", "tardó demasiado", { retriable: true }),
    });
    s.worker.ai = { generator, model: "nano-test", pricing: PRICING };
    const run = await s.request({ source: "ai", prompt: "Un living", format: "4:5" });
    // Aunque no sea el último intento, el pedido falla: otra llamada cobraría de nuevo.
    expect(await s.work(run.id, false)).toEqual({
      outcome: "failed",
      code: "IMAGE_AI_UNAVAILABLE",
    });
    expect(generator.prompts).toHaveLength(1);
    expect(await s.runs.get(run.id)).toMatchObject({ status: "failed", costUsd: 0.04 });
  });

  it("IA: un 429 o un bloqueo de la indicación (sin cobrar) devuelve la reserva", async () => {
    const s = await setup();
    s.worker.ai = {
      generator: createFakeImageGenerator({
        error: new AppError("IMAGE_AI_RATE_LIMITED", "espera", {
          retriable: true,
          details: IMAGE_AI_NOT_CHARGED,
        }),
      }),
      model: "nano-test",
      pricing: PRICING,
    };
    const run = await s.request({ source: "ai", prompt: "Un living", format: "4:5" });
    expect(await s.work(run.id, false)).toEqual({
      outcome: "failed",
      code: "IMAGE_AI_RATE_LIMITED",
    });
    expect(await s.runs.get(run.id)).toMatchObject({ status: "failed", costUsd: null });
  });

  it("IA: si R2 falla después de cobrar, una sola llamada y un solo costo", async () => {
    const s = await setup();
    s.worker.storage = {
      ...s.storage,
      put: async () => {
        throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
      },
    } as never;
    const run = await s.request({ source: "ai", prompt: "Un living", format: "4:5" });
    expect(await s.work(run.id, false)).toEqual({
      outcome: "failed",
      code: "STORAGE_UNAVAILABLE",
    });
    // El job no la reintenta, y si igual volviera a correr, no llama otra vez.
    expect(await s.work(run.id, false)).toEqual({ outcome: "skipped", reason: "not_active" });
    expect(s.generator.prompts).toHaveLength(1);
    expect(await s.runs.get(run.id)).toMatchObject({ costUsd: 0.04 });
  });

  it("IA: un intento cortado a medias (con la reserva hecha) no vuelve a llamar", async () => {
    const s = await setup();
    const run = await s.request({ source: "ai", prompt: "Un living", format: "4:5" });
    await s.runs.markRunning(run.id);
    const range = { from: new Date("2000-01-01"), to: new Date("2100-01-01") };
    await s.runs.reserveImageCost(run.id, { costUsd: 0.04, model: "nano", capUsd: 2, ...range });
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "IMAGE_AI_INTERRUPTED" });
    expect(s.generator.prompts).toEqual([]);
    expect((await s.runs.get(run.id))?.costUsd).toBe(0.04);
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

  it("el worker se niega si otro post de la marca llenó el tope después de pedir", async () => {
    const s = await setup();
    const run = await s.request({ source: "ai", prompt: "Una casa", format: "4:5" });
    // Otro post de la misma marca reserva entre medio: la reserva de este ya no cabe.
    const other = await s.posts.create({ brokerId: s.broker.id, topic: "Otro", kind: "image" });
    const otherRun = await requestPostImage(s.api, ADMIN, other.id, {
      source: "ai",
      prompt: "Otra casa",
      format: "4:5",
    });
    const range = { from: new Date("2000-01-01"), to: new Date("2100-01-01") };
    expect(
      await s.runs.reserveImageCost(otherRun.id, {
        costUsd: 0.09,
        model: "n",
        capUsd: 0.1,
        ...range,
      }),
    ).toBe(true);
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "IMAGE_AI_BUDGET_EXCEEDED" });
    expect(s.generator.prompts).toEqual([]);
    expect((await s.runs.get(run.id))?.costUsd).toBeNull();
    expect(fakeJpeg("x")[0]).toBe(0xff);
  });
});

// El caso visto en producción: un carrusel de AgentPey para X y Discord, con 4 textos (español e
// inglés en cada red), salió con 10 tarjetas y X lo rechazó (admite 4).
describe("tarjetas de un carrusel para X y Discord con cuatro textos", () => {
  const points = (prefix: string) =>
    Array.from({ length: 6 }, (_, i) => `- ${prefix} punto ${i + 1}`).join("\n");
  const fourTexts: Text[] = [
    { platform: "x", language: "es", body: points("X es") },
    { platform: "x", language: "en", body: points("X en") },
    { platform: "discord", language: "es", body: points("Discord es") },
    { platform: "discord", language: "en", body: points("Discord en") },
  ];
  const caseOf = (extra: Parameters<typeof setup>[0] = {}) =>
    setup({ texts: fourTexts, platforms: ["x", "discord"], languages: ["es", "en"], ...extra });

  it("hace 4 tarjetas (portada, 2 puntos y cierre) con un solo texto, el del idioma principal", async () => {
    const s = await caseOf();
    const run = await s.request({ source: "card", format: "4:5" });
    expect(await s.work(run.id)).toMatchObject({ outcome: "succeeded", created: 4 });
    expect(s.cards.calls.map((call) => [call.card.role, call.card.text])).toEqual([
      ["cover", "Cómo fijar el precio"],
      ["point", "Discord es punto 1"],
      ["point", "Discord es punto 2"],
      ["closing", "AgentPey"],
    ]);
    expect(await s.media.listOriginals({ kind: "post", id: s.post.id })).toHaveLength(4);
  });

  it("si el idioma principal de la marca es el inglés, los puntos salen del texto en inglés", async () => {
    const s = await caseOf({ languages: ["en", "es"] });
    await s.work((await s.request({ source: "card", format: "4:5" })).id);
    expect(
      s.cards.calls.filter((call) => call.card.role === "point").map((call) => call.card.text),
    ).toEqual(["Discord en punto 1", "Discord en punto 2"]);
  });

  it("con un solo idioma en la marca, usa ese", async () => {
    const s = await caseOf({ languages: ["es"] });
    await s.work((await s.request({ source: "card", format: "4:5" })).id);
    const pointTexts = s.cards.calls
      .filter((call) => call.card.role === "point")
      .map((call) => call.card.text);
    expect(pointTexts).toHaveLength(2);
    expect(pointTexts.every((text) => text.includes(" es "))).toBe(true);
  });

  it("sin X, el carrusel de Discord llega a 10 tarjetas", async () => {
    const s = await setup({
      texts: [{ platform: "discord", language: "es", body: points("Discord es") }],
      platforms: ["discord"],
      languages: ["es"],
    });
    await s.work((await s.request({ source: "card", format: "4:5" })).id);
    // Con 6 puntos en el texto: portada, 6 puntos y cierre.
    expect(s.cards.calls).toHaveLength(8);
  });

  it("antes de pedir, las opciones dicen cuántas saldrán y por qué", async () => {
    const s = await caseOf();
    const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
    expect(options.cards).toEqual({
      languages: [
        {
          language: "es",
          count: 4,
          existing: 0,
          message:
            "4 tarjetas: X admite hasta 4 imágenes por post; portada, 2 puntos y cierre, del texto en español.",
        },
        {
          language: "en",
          count: 4,
          existing: 0,
          message:
            "4 tarjetas: X admite hasta 4 imágenes por post; portada, 2 puntos y cierre, del texto en inglés.",
        },
      ],
      existing: 0,
      unknown: 0,
    });
  });

  it("un video sin texto: las opciones piden el texto primero; un post de texto no tiene tarjetas", async () => {
    const video = await setup({ kind: "video", body: "" });
    expect((await getPostImageOptions(video.api, ADMIN, video.post.id)).cards).toMatchObject({
      languages: [{ language: "es", count: null }],
    });
    const text = await setup({ kind: "text" });
    expect((await getPostImageOptions(text.api, ADMIN, text.post.id)).cards).toBeNull();
  });
});

describe("quitar las tarjetas anteriores", () => {
  const OTHER_BROKER = { id: "u-2", role: "broker" as const, brokerId: "otra-marca" };
  type Scenario = Awaited<ReturnType<typeof setup>>;

  /** Una foto que subió el usuario: su medio y su archivo en R2. */
  async function userUpload(s: Scenario) {
    const path = `posts/${s.post.id}/original/subida.jpg`;
    await s.storage.put(path, fakeJpeg("subida"), "image/jpeg");
    return s.media.create({
      listingId: null,
      postId: s.post.id,
      brokerId: s.broker.id,
      kind: "image",
      storagePath: path,
      mime: "image/jpeg",
      bytes: 6,
      checksum: "a".repeat(64),
      sortOrder: 0,
      isCover: false,
    });
  }

  const originals = (s: Scenario) => s.media.listOriginals({ kind: "post", id: s.post.id });
  const ids = async (s: Scenario) => (await originals(s)).map((item) => item.id);

  async function withCardsAndUpload() {
    const s = await setup();
    const upload = await userUpload(s);
    await s.work((await s.request({ source: "card", format: "4:5" })).id);
    const cards = (await ids(s)).filter((id) => id !== upload.id);
    return { s, upload, cards };
  }

  /** Los estados que bloquean quitar las tarjetas, y el camino para llegar a cada uno. */
  const KEPT_ROUTES = {
    approved: [],
    scheduled: ["scheduled"],
    publishing: ["publishing"],
    awaiting_manual_confirm: ["publishing", "awaiting_manual_confirm"],
    published: ["publishing", "published"],
    paused: ["publishing", "published", "paused"],
    outcome_unknown: ["publishing", "outcome_unknown"],
  } as const satisfies Record<string, readonly PublicationStatus[]>;

  /** Una publicación del post que usa estos medios, en el estado dado. */
  async function publicationIn(s: Scenario, status: keyof typeof KEPT_ROUTES) {
    let current = await s.publications.create(
      {
        postId: s.post.id,
        platformAccountId: "cuenta-1",
        platform: "x",
        format: "post",
        contentId: "texto-1",
        mediaIds: await ids(s),
      },
      { actor: "operator" },
    );
    for (const to of KEPT_ROUTES[status]) {
      current = await s.publications.transition(
        current.id,
        {
          from: current.status,
          to,
          changes: {
            dryRun: true,
            ...(to === "scheduled" ? { scheduledAt: new Date("2026-10-30T15:00:00Z") } : {}),
            ...(to === "published" ? { publishedAt: new Date("2026-10-30T15:00:00Z") } : {}),
          },
        },
        { actor: "operator" },
      );
    }
    return current;
  }

  /** Cambia el texto del post: los puntos de las tarjetas ya no son los mismos. */
  const rewriteText = (s: Scenario) => {
    s.worker.contents = {
      listCurrent: async () =>
        [
          { platform: "instagram", language: "es", body: "- Otro punto uno\n- Otro punto dos" },
        ] as never,
    };
  };

  it("quita solo las tarjetas, con sus variantes y sus archivos; lo subido por el usuario queda", async () => {
    const { s, upload, cards } = await withCardsAndUpload();
    expect(cards).toHaveLength(4);
    const all = await originals(s);
    const cardPaths = all.filter((item) => cards.includes(item.id)).map((i) => i.storagePath);
    const parent = all.find((item) => item.id === cards[0]);
    if (parent === undefined) throw new Error("falta la primera tarjeta");
    const variant = await s.media.upsertDerivative({
      role: "processed",
      variant: "thumb",
      parentMediaId: parent.id,
      postId: s.post.id,
      brokerId: s.broker.id,
      kind: "image",
      storagePath: `posts/${s.post.id}/processed/thumb/${parent.id}.jpg`,
      mime: "image/jpeg",
      width: 100,
      height: 100,
      durationS: null,
      bytes: 10,
      checksum: "b".repeat(64),
    });
    await s.storage.put(variant.media.storagePath, fakeJpeg("thumb"), "image/jpeg");

    expect(await removePostCards(s.api, ADMIN, s.post.id)).toEqual({ removed: 4, leftover: 0 });
    expect(await ids(s)).toEqual([upload.id]);
    expect(await s.media.get(variant.media.id)).toBeNull();
    for (const path of [...cardPaths, variant.media.storagePath]) {
      expect(await s.storage.head(path)).toBeNull();
    }
    expect(await s.storage.head(upload.storagePath)).not.toBeNull();
  });

  it("las opciones cuentan las tarjetas que ya tiene el post, no lo subido", async () => {
    const { s } = await withCardsAndUpload();
    expect((await getPostImageOptions(s.api, ADMIN, s.post.id)).cards?.existing).toBe(4);
    await removePostCards(s.api, ADMIN, s.post.id);
    expect((await getPostImageOptions(s.api, ADMIN, s.post.id)).cards?.existing).toBe(0);
  });

  it("no toca una foto de la biblioteca ni una imagen con IA", async () => {
    const s = await setup();
    await s.work(
      (await s.request({ source: "stock", photoId: "1", query: "x", format: "4:5" })).id,
    );
    await s.work((await s.request({ source: "ai", prompt: "Una casa", format: "4:5" })).id);
    const before = await ids(s);
    expect(before).toHaveLength(2);
    expect(await removePostCards(s.api, ADMIN, s.post.id)).toEqual({ removed: 0, leftover: 0 });
    expect(await ids(s)).toEqual(before);
  });

  it("replaceCards: el pedido no borra nada; el worker quita las anteriores al terminar y reutiliza las idénticas", async () => {
    const { s, upload, cards } = await withCardsAndUpload();
    const [cover, firstPoint, secondPoint, closing] = cards;
    rewriteText(s);
    const run = await s.request({ source: "card", format: "4:5", replaceCards: true });
    // Hasta que el worker termina, el post conserva lo que tenía.
    expect(await ids(s)).toHaveLength(5);
    const oldPaths = (await originals(s))
      .filter((item) => [firstPoint, secondPoint].includes(item.id))
      .map((item) => item.storagePath);

    expect(await s.work(run.id)).toMatchObject({
      outcome: "succeeded",
      created: 2,
      replaced: 2,
      leftover: [],
    });
    const after = await ids(s);
    expect(after).toHaveLength(5);
    // La portada y el cierre salen idénticos: son los mismos medios, no se borran ni se duplican.
    expect(after).toEqual(expect.arrayContaining([upload.id, cover, closing]));
    expect(after).not.toContain(firstPoint);
    expect(after).not.toContain(secondPoint);
    for (const path of oldPaths) expect(await s.storage.head(path)).toBeNull();
  });

  it("si el pedido de reemplazo falla, el post conserva las tarjetas que tenía", async () => {
    const { s } = await withCardsAndUpload();
    const before = await ids(s);
    s.worker.cards = {
      ...s.cards,
      render: async () => {
        throw new AppError("CARD_RENDER_FAILED", "No se pudo dibujar");
      },
    };
    const run = await s.request({ source: "card", format: "4:5", replaceCards: true });
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "CARD_RENDER_FAILED" });
    expect(await ids(s)).toEqual(before);
  });

  it("si una publicación toma las tarjetas después de pedir, el worker falla con POST_CARDS_IN_USE y no borra", async () => {
    const { s } = await withCardsAndUpload();
    rewriteText(s);
    const run = await s.request({ source: "card", format: "4:5", replaceCards: true });
    await publicationIn(s, "approved");
    expect(await s.work(run.id)).toEqual({ outcome: "failed", code: "POST_CARDS_IN_USE" });
    expect(await ids(s)).toHaveLength(5);
  });

  it("los archivos de R2 que no se pueden borrar se cuentan, no se tragan", async () => {
    const { s, upload } = await withCardsAndUpload();
    const broken = {
      ...s.api,
      storage: {
        delete: async () => {
          throw new Error("R2 caído");
        },
      },
    };
    expect(await removePostCards(broken, ADMIN, s.post.id)).toEqual({ removed: 4, leftover: 4 });
    expect(await ids(s)).toEqual([upload.id]);
  });

  it("una foto tuya con exactamente los mismos bytes que una tarjeta cuenta como esa tarjeta", async () => {
    // Límite conocido (ADR-0038): el mismo contenido es el mismo medio, y el pedido de tarjetas
    // que lo reutiliza lo anota como suyo.
    const s = await setup({ kind: "image" });
    await s.work((await s.request({ source: "card", format: "4:5" })).id);
    const [card] = await originals(s);
    if (card === undefined) throw new Error("falta la tarjeta");
    await removePostCards(s.api, ADMIN, s.post.id);
    // El usuario sube justo esos bytes; después piden las tarjetas de nuevo: reutiliza su medio.
    const mine = await s.media.create({
      listingId: null,
      postId: s.post.id,
      brokerId: s.broker.id,
      kind: "image",
      storagePath: card.storagePath,
      mime: card.mime,
      bytes: card.bytes,
      checksum: card.checksum,
      sortOrder: 0,
      isCover: false,
    });
    expect(await s.work((await s.request({ source: "card", format: "4:5" })).id)).toMatchObject({
      created: 0,
    });
    expect(await removePostCards(s.api, ADMIN, s.post.id)).toMatchObject({ removed: 1 });
    expect(await ids(s)).not.toContain(mine.id);
  });

  it("sin replaceCards, los medios anteriores se quedan", async () => {
    const { s } = await withCardsAndUpload();
    await s.request({ source: "card", format: "4:5" });
    expect(await ids(s)).toHaveLength(5);
  });

  it("con un pedido en curso no quita nada", async () => {
    const { s } = await withCardsAndUpload();
    await s.request({ source: "card", format: "4:5" });
    expect(await codeOf(removePostCards(s.api, ADMIN, s.post.id))).toBe("POST_IMAGE_RUN_ACTIVE");
    expect(await codeOf(s.request({ source: "card", format: "4:5", replaceCards: true }))).toBe(
      "POST_IMAGE_RUN_ACTIVE",
    );
    expect(await ids(s)).toHaveLength(5);
  });

  it.each(Object.keys(KEPT_ROUTES) as (keyof typeof KEPT_ROUTES)[])(
    "una publicación %s las usa: POST_CARDS_IN_USE y no borra nada",
    async (status) => {
      const { s } = await withCardsAndUpload();
      await publicationIn(s, status);
      expect(await codeOf(removePostCards(s.api, ADMIN, s.post.id))).toBe("POST_CARDS_IN_USE");
      expect(await codeOf(s.request({ source: "card", format: "4:5", replaceCards: true }))).toBe(
        "POST_CARDS_IN_USE",
      );
      expect(await ids(s)).toHaveLength(5);
    },
  );

  it("una publicación cancelada no impide quitarlas", async () => {
    const { s, upload } = await withCardsAndUpload();
    const created = await publicationIn(s, "approved");
    await s.publications.transition(
      created.id,
      { from: "approved", to: "cancelled" },
      { actor: "operator" },
    );
    expect(await removePostCards(s.api, ADMIN, s.post.id)).toEqual({ removed: 4, leftover: 0 });
    expect(await ids(s)).toEqual([upload.id]);
  });

  it("el acceso se revisa: lo de otra marca es 404 y un post archivado no se toca", async () => {
    const { s } = await withCardsAndUpload();
    expect(await codeOf(removePostCards(s.api, OTHER_BROKER, s.post.id))).toBe("POST_NOT_FOUND");
    expect(await ids(s)).toHaveLength(5);
    await s.posts.update(s.post.id, { status: "archived" });
    expect(await codeOf(removePostCards(s.api, ADMIN, s.post.id))).toBe("POST_ARCHIVED");
  });
});

describe("tarjetas por idioma", () => {
  // Un post bilingüe para X: cada texto tiene su primera oración (el título de su portada) y sus
  // puntos. El tema del post está en español.
  const bilingual: Text[] = [
    {
      platform: "x",
      language: "es",
      body: "Fijar el precio es difícil. Tres claves:\n- Mira el mercado\n- Revisa los gastos",
    },
    {
      platform: "x",
      language: "en",
      body: "Pricing is hard. Three keys:\n- Check the market\n- Review costs",
    },
  ];
  const caseOf = (extra: Parameters<typeof setup>[0] = {}) =>
    setup({ texts: bilingual, platforms: ["x"], languages: ["en", "es"], ...extra });
  type Case = Awaited<ReturnType<typeof caseOf>>;
  const originals = (s: Case) => s.media.listOriginals({ kind: "post", id: s.post.id });
  /** El idioma de cada tarjeta, como lo entiende la publicación. */
  const languagesOfMedia = (s: Case) => cardLanguagesOf(s.runs.all());

  it("el pedido guarda su idioma: el que pide el usuario o, si no dice, el principal de la marca", async () => {
    const s = await caseOf();
    const first = await s.request({ source: "card", format: "4:5" });
    expect(first.request).toEqual({ source: "card", format: "4:5", language: "en" });
    await s.runs.markFailed(first.id, { code: "X", message: "x" });
    const second = await s.request({ source: "card", format: "4:5", language: "es" });
    expect(second.request).toMatchObject({ language: "es" });
  });

  it("cada idioma hace sus tarjetas con su texto: portada, puntos y cierre, sin mezclar", async () => {
    const s = await caseOf();
    const es = await s.request({ source: "card", format: "4:5", language: "es" });
    expect(await s.work(es.id)).toMatchObject({ outcome: "succeeded", created: 4 });
    expect(s.cards.calls.map((call) => [call.card.role, call.card.text])).toEqual([
      ["cover", "Fijar el precio es difícil"],
      ["point", "Mira el mercado"],
      ["point", "Revisa los gastos"],
      ["closing", "AgentPey"],
    ]);
    s.cards.calls.length = 0;
    const en = await s.request({ source: "card", format: "4:5", language: "en" });
    // El cierre con la marca es idéntico: es el mismo medio y no se duplica.
    expect(await s.work(en.id)).toMatchObject({ outcome: "succeeded", created: 3 });
    expect(s.cards.calls.map((call) => [call.card.role, call.card.text])).toEqual([
      ["cover", "Pricing is hard"],
      ["point", "Check the market"],
      ["point", "Review costs"],
      ["closing", "AgentPey"],
    ]);
    const languages = languagesOfMedia(s);
    const count = (language: Language) =>
      [...languages].filter(([, list]) => list.includes(language)).length;
    expect(count("es")).toBe(4);
    expect(count("en")).toBe(4);
    expect(await originals(s)).toHaveLength(7);
  });

  it("«cada idioma»: al terminar el primero, el worker pide el siguiente con su idioma", async () => {
    const s = await caseOf();
    const first = await s.request({
      source: "card",
      format: "4:5",
      language: "es",
      thenLanguages: ["en", "es"],
    });
    // Sin repetir el idioma del propio pedido.
    expect(first.request).toMatchObject({ language: "es", thenLanguages: ["en"] });
    const result = await s.work(first.id);
    expect(result).toMatchObject({ outcome: "succeeded", chained: expect.any(String) });
    const next = s.runs.all().find((item) => item.id !== first.id);
    expect(next).toMatchObject({
      status: "queued",
      request: { source: "card", language: "en", thenLanguages: [] },
    });
    expect(s.queue.jobs.at(-1)).toEqual({
      name: "post.image",
      data: { postImageRunId: next?.id },
      options: { singletonKey: next?.id },
    });
    // El segundo no encadena nada más.
    expect(await s.work(next?.id ?? "")).toMatchObject({ outcome: "succeeded", chained: null });
    expect(await originals(s)).toHaveLength(7);
  });

  it("pedir un idioma sin texto, habiéndolo en el otro, se rechaza con POST_IMAGE_NEEDS_TEXT", async () => {
    const s = await caseOf({ texts: [bilingual[0] as Text] });
    expect(await codeOf(s.request({ source: "card", format: "4:5", language: "en" }))).toBe(
      "POST_IMAGE_NEEDS_TEXT",
    );
    // «Cada idioma» tampoco empieza si uno de los siguientes no se puede hacer.
    expect(
      await codeOf(
        s.request({ source: "card", format: "4:5", language: "es", thenLanguages: ["en"] }),
      ),
    ).toBe("POST_IMAGE_NEEDS_TEXT");
    expect(s.runs.all()).toHaveLength(0);
    // Las opciones no ofrecen ese idioma (cuenta nula y el motivo).
    const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
    expect(options.cards?.languages.find((item) => item.language === "en")).toMatchObject({
      count: null,
      message: expect.stringContaining("hace falta el texto en inglés"),
    });
    // Un post sin ningún texto todavía sí puede hacer sus tarjetas (portada con el tema).
    const none = await caseOf({ texts: [], body: "" });
    expect(await codeOf(none.request({ source: "card", format: "4:5", language: "en" }))).toBe(
      "OK",
    );
  });

  it("«cada idioma» con reemplazo mira que se puedan quitar las de todos los idiomas antes de empezar", async () => {
    const { s } = await (async () => {
      const made = await caseOf();
      await made.work((await made.request({ source: "card", format: "4:5", language: "en" })).id);
      return { s: made };
    })();
    // Una publicación aprobada que usa los medios del post bloquea el reemplazo.
    await s.publications.create(
      {
        postId: s.post.id,
        platformAccountId: "cuenta-1",
        platform: "x",
        format: "post",
        contentId: "texto-1",
        mediaIds: (await s.media.listOriginals({ kind: "post", id: s.post.id })).map(
          (item) => item.id,
        ),
      },
      { actor: "operator" },
    );
    // El español no tiene tarjetas que quitar, pero el inglés sí: se niega todo desde el principio.
    expect(
      await codeOf(
        s.request({
          source: "card",
          format: "4:5",
          language: "es",
          thenLanguages: ["en"],
          replaceCards: true,
        }),
      ),
    ).toBe("POST_CARDS_IN_USE");
    expect(s.runs.all()).toHaveLength(1);
  });

  it("si no se puede pedir el siguiente idioma, el primero queda hecho y se dice por qué", async () => {
    const asked = async (tamper: (s: Case) => void) => {
      const s = await caseOf();
      const first = await s.request({
        source: "card",
        format: "4:5",
        language: "es",
        thenLanguages: ["en"],
      });
      tamper(s);
      return { s, first, result: await s.work(first.id) };
    };
    // Ya hay un pedido activo del post: no se puede crear el siguiente.
    const busy = await asked((s) => {
      s.worker.runs = {
        ...s.runs,
        create: async () => {
          throw new AppError("POST_IMAGE_RUN_ACTIVE", "ya hay uno");
        },
        get: s.runs.get,
        markRunning: s.runs.markRunning,
        markSucceeded: s.runs.markSucceeded,
        markFailed: s.runs.markFailed,
        listByPost: s.runs.listByPost,
        reserveImageCost: s.runs.reserveImageCost,
        releaseImageCost: s.runs.releaseImageCost,
      } as never;
    });
    expect(busy.result).toMatchObject({
      outcome: "succeeded",
      chained: null,
      chainError: "POST_IMAGE_RUN_ACTIVE",
    });
    expect((await busy.s.runs.get(busy.first.id))?.status).toBe("succeeded");
    // La cola no responde: el pedido creado se cierra como failed, no queda en cola.
    const noQueue = await asked((s) => {
      s.worker.queue = {
        enqueue: async (name: string) => {
          if (name === "post.image") throw new Error("sin cola");
        },
      } as never;
    });
    expect(noQueue.result).toMatchObject({
      outcome: "succeeded",
      chained: null,
      chainError: "QUEUE_UNAVAILABLE",
    });
    const second = noQueue.s.runs.all().find((item) => item.id !== noQueue.first.id);
    expect(second).toMatchObject({ status: "failed", error: { code: "QUEUE_UNAVAILABLE" } });
  });

  it("si el primer idioma falla, no se pide el siguiente", async () => {
    const s = await caseOf();
    const first = await s.request({
      source: "card",
      format: "4:5",
      language: "es",
      thenLanguages: ["en"],
    });
    s.worker.cards = {
      render: async () => {
        throw new AppError("CARD_RENDER_FAILED", "no se pudo dibujar");
      },
    } as never;
    expect(await s.work(first.id)).toMatchObject({ outcome: "failed" });
    expect(s.runs.all()).toHaveLength(1);
  });

  it("las opciones cuentan las tarjetas por idioma", async () => {
    const s = await caseOf();
    await s.work((await s.request({ source: "card", format: "4:5", language: "es" })).id);
    const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
    expect(options.cards).toMatchObject({
      languages: [
        { language: "en", existing: 0, count: 4 },
        { language: "es", existing: 4, count: 4 },
      ],
      existing: 4,
      unknown: 0,
    });
    // El mensaje de cada idioma dice de qué texto sale.
    expect(options.cards?.languages[0]?.message).toContain("del texto en inglés");
    expect(options.cards?.languages[1]?.message).toContain("del texto en español");
  });

  describe("rehacer y quitar por idioma", () => {
    async function bothLanguages() {
      const s = await caseOf();
      await s.work((await s.request({ source: "card", format: "4:5", language: "es" })).id);
      await s.work((await s.request({ source: "card", format: "4:5", language: "en" })).id);
      const languages = languagesOfMedia(s);
      const idsOf = (language: Language, only = false) =>
        [...languages]
          .filter(([, list]) => (only ? list.length === 1 : true) && list.includes(language))
          .map(([id]) => id);
      return { s, idsOf };
    }

    it("rehacer las de un idioma no toca las del otro ni el cierre que comparten", async () => {
      const { s, idsOf } = await bothLanguages();
      const run = await s.request({
        source: "card",
        format: "4:5",
        language: "es",
        replaceCards: true,
      });
      // Otro texto en español: sus puntos cambian; la portada y el cierre se reutilizan.
      s.worker.contents = {
        listCurrent: async () =>
          [
            {
              platform: "x",
              language: "es",
              body: "Fijar el precio es difícil. Otro:\n- Uno aquí\n- Dos aquí",
            },
            bilingual[1],
          ] as never,
      };
      expect(await s.work(run.id)).toMatchObject({ outcome: "succeeded", replaced: 2 });
      const left = (await originals(s)).map((item) => item.id);
      for (const id of idsOf("en")) expect(left).toContain(id);
    });

    it("rehacer las de un idioma quita también las de un pedido anterior al idioma", async () => {
      const s = await caseOf();
      const old = await s.runs.create({
        postId: s.post.id,
        brokerId: s.broker.id,
        source: "card",
        request: { source: "card", format: "4:5" },
        createdBy: null,
      });
      await s.runs.markRunning(old.id);
      const legacy = await s.media.create({
        listingId: null,
        postId: s.post.id,
        brokerId: s.broker.id,
        kind: "image",
        storagePath: `posts/${s.post.id}/original/vieja.jpg`,
        mime: "image/jpeg",
        bytes: 1,
        checksum: "9".repeat(64),
        sortOrder: 0,
        isCover: false,
      });
      await s.runs.markSucceeded(old.id, [legacy.id]);
      const run = await s.request({
        source: "card",
        format: "4:5",
        language: "en",
        replaceCards: true,
      });
      expect(await s.work(run.id)).toMatchObject({ outcome: "succeeded", replaced: 1 });
      expect((await originals(s)).map((item) => item.id)).not.toContain(legacy.id);
    });

    it("quitar un idioma deja las del otro; sin idioma, quita todas (también el cierre compartido)", async () => {
      const { s, idsOf } = await bothLanguages();
      const removed = await removePostCards(s.api, ADMIN, s.post.id, "es");
      // Solo las 3 exclusivas del español: el cierre lo usa también el inglés.
      expect(removed.removed).toBe(3);
      const left = (await originals(s)).map((item) => item.id);
      expect(left.sort()).toEqual(idsOf("en").sort());
      expect((await removePostCards(s.api, ADMIN, s.post.id)).removed).toBe(4);
      expect(await originals(s)).toHaveLength(0);
    });

    it("la revisión de cada texto cuenta las imágenes de su idioma: 7 en el post, 4 en cada texto", async () => {
      const { s } = await bothLanguages();
      const texts = bilingual.map((text) => ({ ...text, hashtags: [] }));
      const base = {
        posts: s.posts,
        brokers: s.brokers,
        editorialProfiles: s.api.editorialProfiles,
        media: s.media,
        contents: { listCurrent: async () => texts as never },
        contentRuns: { latest: async () => null },
        publications: s.publications,
      };
      const codesOf = async (postImageRuns?: typeof s.runs) => {
        const result = await getPostContent({ ...base, postImageRuns }, ADMIN, s.post.id);
        return result.contents.map((item) => item.checks.map((check) => check.code));
      };
      // Con el idioma de las tarjetas, cada texto cumple el tope de X (4 imágenes).
      expect(await codesOf(s.runs)).toEqual([[], []]);
      // Sin él, las 7 tarjetas del post se contarían en cada texto.
      expect(await codesOf()).toEqual([["MEDIA_NOT_SUPPORTED"], ["MEDIA_NOT_SUPPORTED"]]);
    });

    it("las opciones cuentan 7 tarjetas en total y 3 exclusivas por idioma (el cierre compartido aparte)", async () => {
      const { s } = await bothLanguages();
      const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
      expect(options.cards?.existing).toBe(7);
      expect(options.cards?.languages.map((item) => item.existing)).toEqual([3, 3]);
    });

    it("quitar un idioma no deja a nadie con solo el cierre: el otro texto sigue con todas las suyas y el quitado usa las que hay", async () => {
      const { s, idsOf } = await bothLanguages();
      await removePostCards(s.api, ADMIN, s.post.id, "es");
      const media = await s.media.listBySubject({ kind: "post", id: s.post.id });
      const cards = cardLanguagesOf(s.runs.all());
      const seen = (language: Language) =>
        mediaForLanguage(media, cards, language)
          .filter((item) => item.role === "original")
          .map((item) => item.id)
          .sort();
      // Inglés: sus 3 tarjetas y el cierre.
      expect(seen("en")).toEqual(idsOf("en").sort());
      // Español ya no tiene tarjetas propias (solo el cierre compartido): publica con las únicas que
      // hay, las del inglés con el cierre, no con una sola imagen.
      expect(seen("es")).toEqual(idsOf("en").sort());
      expect(seen("es").length).toBe(4);
      // Y ya no ofrece quitar nada de español: solo quedaría el cierre compartido.
      const options = await getPostImageOptions(s.api, ADMIN, s.post.id);
      expect(options.cards?.languages.map((item) => [item.language, item.existing])).toEqual([
        ["en", 3],
        ["es", 0],
      ]);
    });
  });
});
