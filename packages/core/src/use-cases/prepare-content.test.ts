import { describe, expect, it } from "vitest";
import type { Broker } from "../broker.js";
import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import { CONTENT_PROMPT_VERSION } from "../content/prompt.js";
import { AppError } from "../errors.js";
import type { Listing } from "../listing.js";
import type { Media } from "../media.js";
import type { NewListing } from "../ports/listing-repository.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import { listingSubject } from "../subject.js";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryHtmlRenderer,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemorySlideTemplates,
  fakeHash,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "../testing/index.js";
import { type PrepareContentDeps, prepareContent } from "./prepare-content.js";

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

type Original = { name: string; kind: "image" | "video"; mime?: string; isCover?: boolean };

const PHOTOS: Original[] = [
  { name: "foto-1", kind: "image" },
  { name: "foto-2", kind: "image", isCover: true },
  { name: "foto-3", kind: "image" },
];
const VIDEO: Original = { name: "video-1", kind: "video", mime: "video/mp4" };

/** Un aviso con sus medios en memoria, listo para preparar su contenido. */
async function setup(
  options: {
    originals?: Original[];
    listing?: Partial<Listing>;
    llm?: ScriptedLlmResponse[];
    videoDurationS?: number;
    photoWidth?: number;
    logo?: { mime: string } | null;
    /** F7-T12: el corredor (propio, tope) y los dos proveedores. */
    broker?: Partial<Broker>;
    ownName?: LLMProvider["name"];
    apiLlm?: ScriptedLlmResponse[] | null;
  } = {},
) {
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const brokerBase = contentBrokerFixture(options.broker);
  let logoMediaId: string | null = null;
  if (options.logo) {
    const path = `brokers/${brokerBase.id}/brand/logo`;
    await storage.put(path, text("logo"), options.logo.mime);
    logoMediaId = (
      await media.create({
        listingId: null,
        brokerId: brokerBase.id,
        kind: "image",
        storagePath: path,
        mime: options.logo.mime,
        bytes: 4,
        checksum: "logo-sha",
        sortOrder: 0,
        isCover: false,
      })
    ).id;
  }
  const broker = { ...brokerBase, logoMediaId };
  const listings = createInMemoryListingRepository();
  const fixture = { ...contentListingFixture(), ...options.listing };
  const {
    id: _id,
    status: _s,
    closeReason: _c,
    createdAt: _a,
    updatedAt: _u,
    externalRef,
    ...rest
  } = fixture;
  const listingData = {
    ...(rest as Omit<NewListing, "externalRef" | "sourceHash">),
    externalRef,
    sourceHash: "hash-1",
  } satisfies NewListing;
  const created = await listings.create(listingData);
  await listings.promoteToReady(created.id);

  const originals = options.originals ?? [...PHOTOS, VIDEO];
  const ids: Record<string, string> = {};
  for (const [index, original] of originals.entries()) {
    const path = `brokers/${broker.id}/listings/${created.id}/original/${original.name}`;
    await storage.put(path, text(original.name), original.mime ?? "image/jpeg");
    const record = await media.create({
      listingId: created.id,
      brokerId: broker.id,
      kind: original.kind,
      storagePath: path,
      mime: original.mime ?? "image/jpeg",
      bytes: original.name.length,
      checksum: `sha-${original.name}`,
      sortOrder: index,
      isCover: original.isCover ?? false,
    });
    ids[original.name] = record.id;
  }

  const contentRepos = createInMemoryContentRepositories({ brokerOfListing: () => broker.id });
  const llm = createInMemoryLlmProvider(
    options.llm ?? Array.from({ length: 10 }, () => ({ data: SAMPLE_CONTENT_DRAFT })),
    options.ownName,
  );
  const apiLlm =
    options.apiLlm === undefined || options.apiLlm === null
      ? null
      : createInMemoryLlmProvider(options.apiLlm, "anthropic-api");
  const processor = createInMemoryMediaProcessor({
    measure: (_, kind) =>
      kind === "image"
        ? { width: options.photoWidth ?? 2000, height: 1500, durationS: null }
        : { width: 1920, height: 1080, durationS: options.videoDurationS ?? 30 },
  });
  const deps: PrepareContentDeps = {
    contentRuns: contentRepos.contentRuns,
    listings,
    brokers: createInMemoryBrokerRepository([broker]),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(contentDefinitionsFixture()),
    media,
    storage,
    processor,
    templates: createInMemorySlideTemplates(),
    renderer: createInMemoryHtmlRenderer(),
    llm,
    apiLlm,
    sha256: fakeHash,
    now: () => 1000,
  };
  const newRun = async (texts = true) => {
    const run = await contentRepos.contentRuns.create({ listingId: created.id, texts });
    return run.id;
  };
  const prepare = async (runId: string, isLastAttempt = true) =>
    prepareContent(deps, { contentRunId: runId, isLastAttempt });
  const derivatives = async () =>
    (await media.listBySubject(listingSubject(created.id))).filter(
      (item) => item.role !== "original",
    );
  return {
    deps,
    media,
    storage,
    listings,
    listingId: created.id,
    listingData,
    ids,
    contentRepos,
    llm,
    apiLlm,
    processor,
    newRun,
    prepare,
    derivatives,
  };
}

const variantsOf = (items: readonly Media[], variant: string) =>
  items.filter((item) => item.variant === variant);

describe("prepareContent · corrida completa", () => {
  it("arma variantes, portada, ficha, reel y los 3 textos, y deja la corrida en succeeded", async () => {
    const t = await setup();
    const runId = await t.newRun();

    const result = await t.prepare(runId);

    expect(result).toMatchObject({ outcome: "succeeded" });
    const items = await t.derivatives();
    expect(variantsOf(items, "thumb")).toHaveLength(4); // 3 fotos y el video
    expect(variantsOf(items, "ig_4x5")).toHaveLength(3);
    expect(variantsOf(items, "pi_4x3")).toHaveLength(3);
    expect(variantsOf(items, "cover")).toHaveLength(1);
    expect(variantsOf(items, "spec_sheet")).toHaveLength(1);
    expect(variantsOf(items, "ig_reel")).toHaveLength(1);
    for (const item of items) expect(t.storage.objects.has(item.storagePath)).toBe(true);

    const run = await t.contentRepos.contentRuns.get(runId);
    expect(run).toMatchObject({ status: "succeeded", stage: "texts" });
    expect(run?.report).toMatchObject({
      media: { processed: 4, existing: 0, failed: 0 },
      renders: { rendered: 2, existing: 0 },
      reel: "created",
      llm: {
        provider: "fake",
        model: "modelo-falso",
        promptVersion: CONTENT_PROMPT_VERSION,
        attempts: 1,
      },
      checks: { instagram: [], portal_inmobiliario: [], fb_marketplace: [] },
      warnings: [],
    });
    const contents = await t.contentRepos.contents.listCurrent(listingSubject(t.listingId));
    expect(contents.map((content) => [content.platform, content.status])).toEqual([
      ["instagram", "draft"],
      ["portal_inmobiliario", "draft"],
      ["fb_marketplace", "draft"],
    ]);
    expect(contents[0]?.rawOutput).toEqual(SAMPLE_CONTENT_DRAFT);
    // Las medidas del original se guardaron.
    const photo = await t.media.get(t.ids["foto-1"] ?? "");
    expect([photo?.width, photo?.height]).toEqual([2000, 1500]);
  });

  it("la portada usa la foto marcada y el reel lleva el texto (operación, tipo, comuna y precio)", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    const templates = t.deps.templates as ReturnType<typeof createInMemorySlideTemplates>;

    const cover = templates.calls.find((call) => call.kind === "cover");
    expect(JSON.stringify(cover?.data)).toContain('"sha256":"');
    expect(JSON.stringify(cover?.data)).toContain("UF 5.800");
    const reel = templates.calls.find((call) => call.kind === "reelOverlay");
    expect(reel?.data).toEqual({
      operation: "sale",
      propertyType: "Departamento",
      comuna: "Ñuñoa",
      price: "UF 5.800",
    });
    const photoFour = (await t.derivatives()).find(
      (item) => item.variant === "ig_4x5" && item.parentMediaId === t.ids["foto-2"],
    );
    expect(JSON.stringify(cover?.data)).toContain(photoFour?.checksum ?? "nada");
  });

  it("una segunda corrida sin cambios no procesa, no dibuja ni sube nada: solo la IA", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    const uploads = t.storage.uploads.length;
    const calls = t.processor.calls.length;
    const renders = (t.deps.renderer as ReturnType<typeof createInMemoryHtmlRenderer>).calls.length;

    const second = await t.newRun();
    const result = await t.prepare(second);

    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(t.storage.uploads).toHaveLength(uploads);
    expect(t.processor.calls).toHaveLength(calls);
    expect((t.deps.renderer as ReturnType<typeof createInMemoryHtmlRenderer>).calls).toHaveLength(
      renders,
    );
    expect(t.llm.requests).toHaveLength(2);
    expect((await t.contentRepos.contentRuns.get(second))?.report).toMatchObject({
      media: { processed: 0, existing: 4, failed: 0 },
      renders: { rendered: 0, existing: 2 },
      reel: "existing",
    });
  });

  it("texts = false: sin IA, y el contenido anterior sigue vigente", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    const before = await t.contentRepos.contents.listCurrent(listingSubject(t.listingId));

    const result = await t.prepare(await t.newRun(false));

    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(t.llm.requests).toHaveLength(1);
    expect(await t.contentRepos.contents.listCurrent(listingSubject(t.listingId))).toEqual(before);
  });

  it("otra versión del procesador regenera las variantes y borra las anteriores de R2", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    const oldPaths = variantsOf(await t.derivatives(), "ig_4x5").map((item) => item.storagePath);

    const next = { ...t.deps, processor: createInMemoryMediaProcessor({ version: "test-2" }) };
    const result = await prepareContent(next, {
      contentRunId: await t.newRun(),
      isLastAttempt: true,
    });

    expect(result).toMatchObject({ report: { media: { processed: 4, existing: 0 } } });
    const newPaths = variantsOf(await t.derivatives(), "ig_4x5").map((item) => item.storagePath);
    expect(newPaths.every((path) => path.endsWith("-vtest-2.jpg"))).toBe(true);
    for (const path of oldPaths) expect(t.storage.objects.has(path)).toBe(false);
    // Una fila por original y variante: se reemplazaron en su lugar.
    expect(variantsOf(await t.derivatives(), "ig_4x5")).toHaveLength(3);
  });

  it("un cambio de precio rehace la portada, la ficha y el reel (y borra los anteriores)", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    const before = await t.derivatives();
    const oldPaths = ["cover", "spec_sheet", "ig_reel"].flatMap((variant) =>
      variantsOf(before, variant).map((item) => item.storagePath),
    );

    await t.listings.update(t.listingId, {
      ...t.listingData,
      priceAmount: 5900,
      sourceHash: "hash-2",
    });
    const runId = await t.newRun();
    await t.prepare(runId);

    expect((await t.contentRepos.contentRuns.get(runId))?.report).toMatchObject({
      media: { processed: 0, existing: 4 },
      renders: { rendered: 2, existing: 0 },
      reel: "created",
    });
    for (const path of oldPaths) expect(t.storage.objects.has(path)).toBe(false);
    expect(variantsOf(await t.derivatives(), "ig_reel")).toHaveLength(1);
  });

  it("si cambia el primer video, borra el reel del anterior y arma el del nuevo", async () => {
    const t = await setup({
      originals: [...PHOTOS, VIDEO, { name: "video-2", kind: "video", mime: "video/mp4" }],
    });
    await t.prepare(await t.newRun());
    const oldReel = variantsOf(await t.derivatives(), "ig_reel")[0];
    expect(oldReel?.parentMediaId).toBe(t.ids["video-1"]);

    await t.media.arrange(listingSubject(t.listingId), [
      { id: t.ids["video-2"] ?? "", sortOrder: 3, isCover: false },
      { id: t.ids["video-1"] ?? "", sortOrder: 4, isCover: false },
    ]);
    await t.prepare(await t.newRun());

    const reels = variantsOf(await t.derivatives(), "ig_reel");
    expect(reels.map((reel) => reel.parentMediaId)).toEqual([t.ids["video-2"]]);
    expect(t.storage.objects.has(oldReel?.storagePath ?? "")).toBe(false);
  });
});

describe("prepareContent · reel con fotos (F9.5-T18)", () => {
  const ascii = (bytes: Uint8Array | undefined) =>
    bytes === undefined ? "" : Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  /** Lo que recibió el procesador falso, en el orden del reel (lo deja en el contenido del MP4). */
  const reelSources = (t: Awaited<ReturnType<typeof setup>>, path: string | undefined) =>
    ascii(t.storage.objects.get(path ?? "")?.body)
      .split(":")[2]
      ?.split("|");
  const photoReelCalls = (t: Awaited<ReturnType<typeof setup>>) =>
    t.processor.calls.filter((call) => call.kind === "photoReel");

  it("sin video y con 3 fotos, arma el reel con las fotos (la portada primero) y con el texto", async () => {
    const t = await setup({ originals: PHOTOS });
    const runId = await t.newRun();

    await t.prepare(runId);

    const reels = variantsOf(await t.derivatives(), "ig_reel");
    expect(reels).toHaveLength(1);
    const reel = reels[0];
    // Cuelga de la portada (foto-2) y su clave dice que sale de fotos.
    expect(reel).toMatchObject({
      parentMediaId: t.ids["foto-2"],
      kind: "video",
      mime: "video/mp4",
      width: 1080,
      height: 1920,
      durationS: 9,
    });
    expect(reel?.storagePath).toMatch(/\/processed\/ig_reel\/photos-[^/]+\.mp4$/);
    expect(reelSources(t, reel?.storagePath)).toEqual(["foto-2", "foto-1", "foto-3"]);
    expect(photoReelCalls(t)).toEqual([
      {
        kind: "photoReel",
        photos: 3,
        mimes: ["image/jpeg", "image/jpeg", "image/jpeg"],
        overlay: true,
        music: null,
      },
    ]);
    expect((await t.contentRepos.contentRuns.get(runId))?.report?.reel).toBe("created");
  });

  it("con video, el reel sale del video y no de las fotos", async () => {
    const t = await setup();

    await t.prepare(await t.newRun());

    const reels = variantsOf(await t.derivatives(), "ig_reel");
    expect(reels.map((reel) => reel.parentMediaId)).toEqual([t.ids["video-1"]]);
    expect(reels[0]?.storagePath).not.toContain("/photos-");
    expect(photoReelCalls(t)).toEqual([]);
  });

  it("si nada cambió, no lo rehace; otra portada o un precio nuevo sí (y borra el anterior)", async () => {
    const t = await setup({ originals: PHOTOS });
    await t.prepare(await t.newRun());
    const first = variantsOf(await t.derivatives(), "ig_reel")[0];

    const again = await t.newRun();
    await t.prepare(again);
    expect((await t.contentRepos.contentRuns.get(again))?.report?.reel).toBe("existing");
    expect(photoReelCalls(t)).toHaveLength(1);

    // Otra portada: otro orden, otra clave y otro padre.
    await t.media.arrange(listingSubject(t.listingId), [
      { id: t.ids["foto-3"] ?? "", sortOrder: 2, isCover: true },
    ]);
    await t.prepare(await t.newRun());
    const afterCover = variantsOf(await t.derivatives(), "ig_reel");
    expect(afterCover.map((reel) => reel.parentMediaId)).toEqual([t.ids["foto-3"]]);
    expect(reelSources(t, afterCover[0]?.storagePath)).toEqual(["foto-3", "foto-1", "foto-2"]);
    expect(t.storage.objects.has(first?.storagePath ?? "")).toBe(false);

    // Un precio nuevo cambia el texto: se rehace con la misma portada.
    await t.listings.update(t.listingId, {
      ...t.listingData,
      priceAmount: 5900,
      sourceHash: "hash-2",
    });
    await t.prepare(await t.newRun());
    const afterPrice = variantsOf(await t.derivatives(), "ig_reel");
    expect(afterPrice).toHaveLength(1);
    expect(afterPrice[0]?.storagePath).not.toBe(afterCover[0]?.storagePath);
    expect(t.storage.objects.has(afterCover[0]?.storagePath ?? "")).toBe(false);
    expect(photoReelCalls(t)).toHaveLength(3);
  });

  it("usa hasta 10 fotos y no cuenta las que no se pudieron procesar", async () => {
    const many: Original[] = Array.from({ length: 12 }, (_, index) => ({
      name: `foto-${index + 1}`,
      kind: "image",
    }));
    const t = await setup({ originals: [{ name: "CORRUPTO-1", kind: "image" }, ...many] });

    await t.prepare(await t.newRun());

    expect(photoReelCalls(t)).toMatchObject([{ photos: 10 }]);
    const reel = variantsOf(await t.derivatives(), "ig_reel")[0];
    expect(reelSources(t, reel?.storagePath)).toEqual(many.slice(0, 10).map((p) => p.name));

    // Con 2 fotos buenas y una ilegible, no alcanza: sin reel.
    const few = await setup({
      originals: [{ name: "CORRUPTO-1", kind: "image" }, ...PHOTOS.slice(0, 2)],
    });
    const runId = await few.newRun();
    await few.prepare(runId);
    expect((await few.contentRepos.contentRuns.get(runId))?.report?.reel).toBe("none");
    expect(photoReelCalls(few)).toEqual([]);
  });

  it("si después llega un video, el reel con fotos se borra y sale el del video", async () => {
    const t = await setup({ originals: PHOTOS });
    await t.prepare(await t.newRun());
    const photoReel = variantsOf(await t.derivatives(), "ig_reel")[0];

    const brokerId = photoReel?.brokerId ?? "";
    const path = `brokers/${brokerId}/listings/${t.listingId}/original/video-nuevo`;
    await t.storage.put(
      path,
      Uint8Array.from("video-nuevo", (c) => c.charCodeAt(0)),
      "video/mp4",
    );
    const video = await t.media.create({
      listingId: t.listingId,
      brokerId,
      kind: "video",
      storagePath: path,
      mime: "video/mp4",
      bytes: 11,
      checksum: "sha-video-nuevo",
      sortOrder: 5,
      isCover: false,
    });
    await t.prepare(await t.newRun());

    const reels = variantsOf(await t.derivatives(), "ig_reel");
    expect(reels.map((reel) => reel.parentMediaId)).toEqual([video.id]);
    expect(t.storage.objects.has(photoReel?.storagePath ?? "")).toBe(false);
  });

  it("si las fotos no se pueden armar como reel, avisa y el anterior no queda vigente", async () => {
    const t = await setup({ originals: PHOTOS });
    await t.prepare(await t.newRun());
    const oldReel = variantsOf(await t.derivatives(), "ig_reel")[0];

    await t.listings.update(t.listingId, {
      ...t.listingData,
      priceAmount: 5900,
      sourceHash: "hash-2",
    });
    const broken = {
      ...t.deps,
      processor: {
        ...t.deps.processor,
        version: t.deps.processor.version,
        processImage: t.deps.processor.processImage,
        processVideo: t.deps.processor.processVideo,
        async processPhotoReel(): Promise<never> {
          throw new AppError("MEDIA_DECODE_FAILED", "No se pudo leer el medio");
        },
      },
    };
    const runId = await t.newRun();
    await prepareContent(broken, { contentRunId: runId, isLastAttempt: true });

    const run = await t.contentRepos.contentRuns.get(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.report?.reel).toBe("skipped");
    expect(run?.report?.warnings).toContain(
      "No se pudo armar el reel con las fotos (formato no válido o archivo dañado)",
    );
    expect(variantsOf(await t.derivatives(), "ig_reel")).toEqual([]);
    expect(t.storage.objects.has(oldReel?.storagePath ?? "")).toBe(false);
  });
});

describe("prepareContent · música del reel (F9.5-T19)", () => {
  const upload = (t: Awaited<ReturnType<typeof setup>>, id: string, body: string) =>
    t.storage.put(`assets/musica/${id}.mp3`, text(body), "audio/mpeg");
  const reelOf = async (t: Awaited<ReturnType<typeof setup>>) =>
    variantsOf(await t.derivatives(), "ig_reel")[0];
  const lastVideoCall = (t: Awaited<ReturnType<typeof setup>>) =>
    t.processor.calls.filter((call) => call.kind === "video" && call.reel).at(-1);

  it("elegir una pista rehace el reel con ella; quitarla vuelve a la clave de antes", async () => {
    const t = await setup();
    await upload(t, "calm-piano", "PIANO");
    await upload(t, "up-in-the-sky", "CIELO");
    await t.prepare(await t.newRun(false));
    const plain = await reelOf(t);
    expect(lastVideoCall(t)).toMatchObject({ music: null });

    await t.listings.setMusicTrack(t.listingId, "calm-piano");
    const withMusic = await t.newRun(false);
    await t.prepare(withMusic);
    const piano = await reelOf(t);
    expect((await t.contentRepos.contentRuns.get(withMusic))?.report).toMatchObject({
      reel: "created",
      warnings: [],
    });
    expect(piano?.storagePath).not.toBe(plain?.storagePath);
    expect(lastVideoCall(t)).toMatchObject({ music: "PIANO" });
    // El reel sin música se reemplazó y se borró de R2.
    expect(t.storage.objects.has(plain?.storagePath ?? "")).toBe(false);

    // Sin cambios, no se rehace.
    const same = await t.newRun(false);
    await t.prepare(same);
    expect((await t.contentRepos.contentRuns.get(same))?.report?.reel).toBe("existing");

    await t.listings.setMusicTrack(t.listingId, "up-in-the-sky");
    await t.prepare(await t.newRun(false));
    expect(lastVideoCall(t)).toMatchObject({ music: "CIELO" });
    expect((await reelOf(t))?.storagePath).not.toBe(piano?.storagePath);

    // «Sin música»: la misma clave que antes de elegir una pista (como antes de F9.5-T19).
    await t.listings.setMusicTrack(t.listingId, null);
    await t.prepare(await t.newRun(false));
    expect((await reelOf(t))?.storagePath).toBe(plain?.storagePath);
    expect(lastVideoCall(t)).toMatchObject({ music: null });
  });

  it("el reel con fotos también lleva la música elegida", async () => {
    const t = await setup({ originals: PHOTOS });
    await upload(t, "serenade-guitar", "GUITARRA");
    await t.prepare(await t.newRun(false));
    const plain = await reelOf(t);
    await t.listings.setMusicTrack(t.listingId, "serenade-guitar");
    await t.prepare(await t.newRun(false));
    const reel = await reelOf(t);
    expect(reel?.storagePath).toMatch(/\/processed\/ig_reel\/photos-[^/]+\.mp4$/);
    expect(reel?.storagePath).not.toBe(plain?.storagePath);
    expect(t.processor.calls.filter((call) => call.kind === "photoReel").at(-1)).toMatchObject({
      music: "GUITARRA",
    });
  });

  it("una pista que no está en R2: el reel sale sin música (la clave de siempre) y se avisa", async () => {
    const t = await setup();
    await t.prepare(await t.newRun(false));
    const plain = await reelOf(t);
    await t.listings.setMusicTrack(t.listingId, "calm-piano");
    const runId = await t.newRun(false);
    await t.prepare(runId);
    const run = await t.contentRepos.contentRuns.get(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.report).toMatchObject({ reel: "existing" });
    expect(run?.report?.warnings).toEqual([
      expect.stringContaining("«Calm Piano 1 (Vaporware)» todavía no está subida"),
    ]);
    expect((await reelOf(t))?.storagePath).toBe(plain?.storagePath);

    // Cuando el operador la sube, la siguiente preparación rehace el reel con ella.
    await upload(t, "calm-piano", "PIANO");
    const after = await t.newRun(false);
    await t.prepare(after);
    expect((await t.contentRepos.contentRuns.get(after))?.report).toMatchObject({
      reel: "created",
      warnings: [],
    });
  });

  it("una pista que ya no está en el catálogo: sin música y con aviso", async () => {
    const t = await setup();
    await t.listings.setMusicTrack(t.listingId, "pista-retirada");
    const runId = await t.newRun(false);
    await t.prepare(runId);
    expect((await t.contentRepos.contentRuns.get(runId))?.report?.warnings).toEqual([
      expect.stringContaining("ya no está en la biblioteca"),
    ]);
    expect(lastVideoCall(t)).toMatchObject({ music: null });
  });
});

describe("prepareContent · avisos y datos", () => {
  it("sin video y con menos de 3 fotos, el reel es none; un video de menos de 3 s no da reel y avisa, sin volver a bajarlo", async () => {
    const none = await setup({ originals: PHOTOS.slice(0, 2) });
    await none.prepare(await none.newRun());
    expect(
      (
        await none.contentRepos.contentRuns.get(
          (await none.contentRepos.contentRuns.latest(listingSubject(none.listingId)))?.id ?? "",
        )
      )?.report?.reel,
    ).toBe("none");
    expect(none.processor.calls.filter((call) => call.kind === "photoReel")).toEqual([]);
    expect(variantsOf(await none.derivatives(), "ig_reel")).toEqual([]);

    const short = await setup({ videoDurationS: 2 });
    const runId = await short.newRun();
    await short.prepare(runId);
    const report = (await short.contentRepos.contentRuns.get(runId))?.report;
    expect(report?.reel).toBe("skipped");
    expect(report?.warnings).toContain(
      "Video 1: El video dura menos de 3 s: Instagram no acepta reels tan cortos, así que no se armó",
    );
    // Solo la pasada de medidas y thumb: el video no se volvió a procesar para el reel.
    expect(short.processor.calls.filter((call) => call.kind === "video")).toHaveLength(1);
    // Con video, las fotos no arman reel aunque el video no sirva (todo como antes de F9.5-T18).
    expect(short.processor.calls.filter((call) => call.kind === "photoReel")).toEqual([]);
  });

  it("las fotos chicas avisan en cada corrida, también si ya estaban procesadas", async () => {
    const t = await setup({ photoWidth: 900 });
    await t.prepare(await t.newRun());
    const runId = await t.newRun();
    await t.prepare(runId);

    const warnings = (await t.contentRepos.contentRuns.get(runId))?.report?.warnings ?? [];
    expect(warnings.filter((warning) => warning.includes("1080 px"))).toHaveLength(3);
    expect(warnings[0]).toMatch(/^Foto 1: /);
  });

  it("la ficha sale de una lista fija: sin la dirección aunque se pueda mostrar, ni campos propios", async () => {
    const t = await setup({ listing: { showExactAddress: true } });
    await t.prepare(await t.newRun());
    const templates = t.deps.templates as ReturnType<typeof createInMemorySlideTemplates>;

    const sheet = JSON.stringify(templates.calls.find((call) => call.kind === "specSheet")?.data);
    expect(sheet).not.toContain("Calle Inventada");
    expect(sheet).not.toContain("Depto 506");
    expect(sheet).toContain("Superficie útil");
    expect(sheet).toContain("+56 9 1111 2222");
  });

  it("un logo HEIC no se incrusta: la portada usa el nombre, con aviso; uno PNG sí va", async () => {
    const heic = await setup({ logo: { mime: "image/heic" } });
    const runId = await heic.newRun();
    await heic.prepare(runId);
    const templates = heic.deps.templates as ReturnType<typeof createInMemorySlideTemplates>;
    expect(JSON.stringify(templates.calls[0]?.data)).toContain('"logo":null');
    expect((await heic.contentRepos.contentRuns.get(runId))?.report?.warnings).toContain(
      "El logo no es JPG, PNG ni WebP: la portada y la ficha muestran el nombre de la marca",
    );

    const png = await setup({ logo: { mime: "image/png" } });
    await png.prepare(await png.newRun());
    const pngTemplates = png.deps.templates as ReturnType<typeof createInMemorySlideTemplates>;
    expect(JSON.stringify(pngTemplates.calls[0]?.data)).toContain('"sha256":"logo-sha"');
  });
});

describe("prepareContent · errores", () => {
  it("un medio ilegible es un aviso y la corrida sigue", async () => {
    const t = await setup({ originals: [{ name: "CORRUPTO-1", kind: "image" }, ...PHOTOS] });
    const runId = await t.newRun();

    await t.prepare(runId);

    const run = await t.contentRepos.contentRuns.get(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.report?.media).toEqual({ processed: 3, existing: 0, failed: 1 });
    expect(run?.report?.warnings).toContain(
      "Foto 1: no se pudo leer (formato no válido o archivo dañado)",
    );
  });

  it("si ninguna foto se puede procesar: CONTENT_NO_PHOTOS y la corrida en failed", async () => {
    const t = await setup({
      originals: [
        { name: "CORRUPTO-1", kind: "image" },
        { name: "CORRUPTO-2", kind: "image" },
      ],
    });
    const runId = await t.newRun();

    await expect(t.prepare(runId)).rejects.toMatchObject({
      code: "CONTENT_NO_PHOTOS",
      retriable: false,
    });
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      error: { code: "CONTENT_NO_PHOTOS" },
      report: { media: { failed: 2 } },
    });
  });

  it("sin sesión de la IA: failed con su mensaje (no reintentable), y los medios ya hechos quedan", async () => {
    const t = await setup({ llm: [{ error: LLM_ERRORS.authRequired() }] });
    const runId = await t.newRun();

    await expect(t.prepare(runId, false)).rejects.toMatchObject({ code: "LLM_AUTH_REQUIRED" });
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      stage: "texts",
      error: { code: "LLM_AUTH_REQUIRED", message: expect.stringContaining("/login") },
    });
    expect(variantsOf(await t.derivatives(), "cover")).toHaveLength(1);
  });

  it("un error reintentable que no es el último intento sube sin tocar la corrida", async () => {
    const t = await setup({ llm: [{ error: LLM_ERRORS.unavailable() }] });
    const runId = await t.newRun();

    await expect(t.prepare(runId, false)).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
      retriable: true,
    });
    expect((await t.contentRepos.contentRuns.get(runId))?.status).toBe("running");
  });

  it("en el último intento, un error reintentable deja la corrida en failed", async () => {
    const t = await setup({ llm: [{ error: LLM_ERRORS.unavailable() }] });
    const runId = await t.newRun();

    await expect(t.prepare(runId, true)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect((await t.contentRepos.contentRuns.get(runId))?.status).toBe("failed");
  });

  it("un error que no es AppError se normaliza a INTERNAL_ERROR, sin su mensaje", async () => {
    const t = await setup();
    const runId = await t.newRun();
    const broken = {
      ...t.deps,
      sha256: () => {
        throw new Error("detalle interno /ruta/secreta");
      },
    };

    await expect(
      prepareContent(broken, { contentRunId: runId, isLastAttempt: false }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    const run = await t.contentRepos.contentRuns.get(runId);
    expect(run?.status).toBe("failed");
    expect(JSON.stringify(run?.error)).not.toContain("/ruta/secreta");
  });

  it("un intento solapado que ya guardó: este termina skipped, sin duplicar textos", async () => {
    const t = await setup();
    const runId = await t.newRun();
    const repos = t.contentRepos.contentRuns;
    const overlapped = {
      ...t.deps,
      contentRuns: {
        ...repos,
        // Otro intento (el que expiró y siguió) guardó justo antes que este.
        async markSucceeded(id: string, result: Parameters<typeof repos.markSucceeded>[1]) {
          await repos.markSucceeded(id, result);
          return repos.markSucceeded(id, result);
        },
      },
    };

    const result = await prepareContent(overlapped, { contentRunId: runId, isLastAttempt: true });

    expect(result).toEqual({ outcome: "skipped", status: "succeeded" });
    expect(await t.contentRepos.contents.listCurrent(listingSubject(t.listingId))).toHaveLength(3);
  });

  it("una corrida ya terminal no se toca", async () => {
    const t = await setup();
    const runId = await t.newRun();
    await t.prepare(runId);
    const calls = t.processor.calls.length;

    expect(await t.prepare(runId)).toEqual({ outcome: "skipped", status: "succeeded" });
    expect(t.processor.calls).toHaveLength(calls);
    expect(t.llm.requests).toHaveLength(1);
  });

  it("al apagar el worker (signal), relanza sin marcar failed, también en el último intento", async () => {
    const t = await setup();
    const runId = await t.newRun();
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };

    await expect(
      prepareContent(t.deps, { contentRunId: runId, isLastAttempt: true, signal }),
    ).rejects.toMatchObject({ retriable: true });
    expect((await t.contentRepos.contentRuns.get(runId))?.status).toBe("running");
  });

  it("una corrida que no existe → CONTENT_RUN_NOT_FOUND", async () => {
    const t = await setup();
    await expect(t.prepare("no-existe")).rejects.toBeInstanceOf(AppError);
    await expect(t.prepare("no-existe")).rejects.toMatchObject({ code: "CONTENT_RUN_NOT_FOUND" });
  });
});

describe("prepareContent · revisión de F2-T10", () => {
  it("un reintento real retoma sin repetir: medios existentes, sin subidas nuevas, y termina succeeded", async () => {
    const t = await setup({
      llm: [{ error: LLM_ERRORS.unavailable() }, { data: SAMPLE_CONTENT_DRAFT }],
    });
    const runId = await t.newRun();
    await expect(t.prepare(runId, false)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    const uploads = t.storage.uploads.length;
    const calls = t.processor.calls.length;

    const retry = await t.prepare(runId, true);

    expect(retry).toMatchObject({
      outcome: "succeeded",
      report: { media: { processed: 0, existing: 4 }, renders: { existing: 2 }, reel: "existing" },
    });
    expect(t.storage.uploads).toHaveLength(uploads);
    expect(t.processor.calls).toHaveLength(calls);
  });

  it("las medidas se guardan antes que las variantes: si la subida falla, la siguiente rehace solo variantes", async () => {
    const t = await setup({ originals: [PHOTOS[0] as Original] });
    const failing = {
      ...t.deps,
      storage: {
        ...t.storage,
        put: async () => {
          throw new AppError("STORAGE_UNAVAILABLE", "R2 no responde brokers/x/y", {
            retriable: true,
          });
        },
      },
    };
    const runId = await t.newRun();
    await expect(
      prepareContent(failing, { contentRunId: runId, isLastAttempt: true }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });

    const photo = await t.media.get(t.ids["foto-1"] ?? "");
    expect(photo?.width).toBe(2000);
    expect(await t.derivatives()).toEqual([]);
    // El error guardado no lleva la clave de R2.
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      error: { code: "STORAGE_UNAVAILABLE", message: "El almacenamiento de archivos no respondió" },
    });

    await t.prepare(await t.newRun());
    const lastCall = t.processor.calls.at(-1);
    expect(lastCall).toMatchObject({ kind: "image", variants: ["thumb", "ig_4x5", "pi_4x3"] });
    expect(variantsOf(await t.derivatives(), "ig_4x5")).toHaveLength(1);
  });

  it("un corte a mitad de corrida (signal) no marca failed y un error no reintentable sube como CONTENT_RUN_ABORTED", async () => {
    const t = await setup();
    const controller = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const processor = t.deps.processor;
    const cutting = {
      ...t.deps,
      processor: {
        version: processor.version,
        processVideo: processor.processVideo,
        processPhotoReel: processor.processPhotoReel,
        async processImage() {
          controller.aborted = true;
          throw new AppError("MEDIA_TOOL_NOT_INSTALLED", "falta ffmpeg");
        },
      },
    };
    const runId = await t.newRun();

    await expect(
      prepareContent(cutting, { contentRunId: runId, isLastAttempt: true, signal: controller }),
    ).rejects.toMatchObject({
      code: "CONTENT_RUN_ABORTED",
      retriable: true,
      cause: expect.objectContaining({ code: "MEDIA_TOOL_NOT_INSTALLED" }),
    });
    expect((await t.contentRepos.contentRuns.get(runId))?.status).toBe("running");
  });

  it("si otro intento cerró la corrida, este se detiene en la siguiente etapa: sin IA y skipped", async () => {
    const t = await setup();
    const runId = await t.newRun();
    const repos = t.contentRepos.contentRuns;
    const closing = {
      ...t.deps,
      contentRuns: {
        ...repos,
        async setStage(id: string, stage: Parameters<typeof repos.setStage>[1]) {
          // El intento solapado terminó la corrida justo antes de la etapa del reel.
          if (stage === "reel")
            await repos.markFailed(id, { code: "OTRO", message: "otro intento" });
          return repos.setStage(id, stage);
        },
      },
    };

    const result = await prepareContent(closing, { contentRunId: runId, isLastAttempt: true });

    expect(result).toEqual({ outcome: "skipped", status: "failed" });
    expect(t.llm.requests).toEqual([]);
    expect(variantsOf(await t.derivatives(), "ig_reel")).toEqual([]);
  });

  it("si el reel no se puede rehacer (tras un cambio de precio), el anterior no queda vigente", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    const oldReel = variantsOf(await t.derivatives(), "ig_reel")[0];

    await t.listings.update(t.listingId, {
      ...t.listingData,
      priceAmount: 5900,
      sourceHash: "hash-2",
    });
    const broken = {
      ...t.deps,
      processor: {
        ...t.deps.processor,
        version: t.deps.processor.version,
        processImage: t.deps.processor.processImage,
        async processVideo() {
          throw new AppError("MEDIA_DECODE_FAILED", "No se pudo leer el medio");
        },
      },
    };
    const runId = await t.newRun();
    await prepareContent(broken, { contentRunId: runId, isLastAttempt: true });

    expect(variantsOf(await t.derivatives(), "ig_reel")).toEqual([]);
    expect(t.storage.objects.has(oldReel?.storagePath ?? "")).toBe(false);
    expect((await t.contentRepos.contentRuns.get(runId))?.report?.reel).toBe("skipped");
  });

  it("si la foto de portada no se puede procesar, la portada anterior no queda vigente", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    expect(variantsOf(await t.derivatives(), "cover")).toHaveLength(1);

    // La foto marcada como portada se reemplaza por una ilegible.
    const corrupt = await t.media.create({
      listingId: t.listingId,
      brokerId: contentBrokerFixture().id,
      kind: "image",
      storagePath: "brokers/x/listings/y/original/corrupta",
      mime: "image/jpeg",
      bytes: 8,
      checksum: "sha-corrupta",
      sortOrder: 9,
      isCover: false,
    });
    await t.storage.put("brokers/x/listings/y/original/corrupta", text("CORRUPTO"), "image/jpeg");
    await t.media.arrange(listingSubject(t.listingId), [
      { id: corrupt.id, sortOrder: 9, isCover: true },
    ]);
    const runId = await t.newRun();
    await t.prepare(runId);

    expect(variantsOf(await t.derivatives(), "cover")).toEqual([]);
    expect((await t.contentRepos.contentRuns.get(runId))?.report?.warnings).toContain(
      "La foto de portada no se pudo procesar: no se armó la portada",
    );
  });

  it("el reporte no lleva claves de R2 ni la dirección (las advertencias de la IA sí van)", async () => {
    const t = await setup({
      originals: [{ name: "CORRUPTO-1", kind: "image" }, ...PHOTOS, VIDEO],
      photoWidth: 900,
      llm: [{ data: { ...SAMPLE_CONTENT_DRAFT, warnings: ["Se omitió un requisito"] } }],
    });
    const runId = await t.newRun();
    await t.prepare(runId);

    const report = JSON.stringify((await t.contentRepos.contentRuns.get(runId))?.report);
    expect(report).not.toContain("brokers/");
    expect(report).not.toContain("Calle Inventada");
    expect(report).toContain("Se omitió un requisito");
  });

  it("después de varias corridas, en R2 quedan solo los originales y los derivados vigentes", async () => {
    const t = await setup();
    await t.prepare(await t.newRun());
    await t.listings.update(t.listingId, {
      ...t.listingData,
      priceAmount: 5900,
      sourceHash: "hash-2",
    });
    await t.prepare(await t.newRun());

    const all = await t.media.listBySubject(listingSubject(t.listingId));
    expect([...t.storage.objects.keys()].sort()).toEqual(
      all.map((item) => item.storagePath).sort(),
    );
  });
});

/** Una llamada de Sonnet 5.5 de US$ 0,70 (300.000 de entrada y 10.000 de salida). */
const SPEND = {
  inputTokens: 300_000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 10_000,
  requestId: "req_1",
};

describe("prepareContent · la IA por corredor y su gasto (F7-T12)", () => {
  it("un corredor no propio usa la API y anota cada llamada con su costo", async () => {
    const t = await setup({
      ownName: "claude-cli",
      llm: [],
      apiLlm: [{ data: SAMPLE_CONTENT_DRAFT, model: "claude-sonnet-5-5", usage: SPEND }],
    });
    const runId = await t.newRun();

    await t.prepare(runId);
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "succeeded",
      report: { llm: { provider: "anthropic-api", model: "claude-sonnet-5-5" } },
      llmUsage: {
        calls: 1,
        provider: "anthropic-api",
        inputTokens: 300_000,
        outputTokens: 10_000,
        costUsd: expect.closeTo(0.7, 10),
        priceTable: expect.any(String),
        requestIds: ["req_1"],
      },
    });
    expect(t.llm.requests).toHaveLength(0);
  });

  it("un corredor propio usa el plan del operador: tokens anotados y costo 0", async () => {
    const t = await setup({
      broker: { operatorOwned: true },
      ownName: "claude-cli",
      llm: [{ data: SAMPLE_CONTENT_DRAFT, model: "claude-sonnet-5-5", usage: SPEND }],
      apiLlm: [],
    });
    const runId = await t.newRun();

    await t.prepare(runId);
    expect((await t.contentRepos.contentRuns.get(runId))?.llmUsage).toMatchObject({
      provider: "claude-cli",
      inputTokens: 300_000,
      costUsd: 0,
      priceTable: null,
    });
    expect(t.apiLlm?.requests).toHaveLength(0);
  });

  it("una corrida que falla después de gastar queda anotada (las dos llamadas)", async () => {
    const t = await setup({
      ownName: "claude-cli",
      apiLlm: [
        { data: { no: "calza" }, model: "claude-sonnet-5-5", usage: SPEND },
        {
          data: { no: "calza" },
          model: "claude-sonnet-5-5",
          usage: { ...SPEND, requestId: "req_2" },
        },
      ],
    });
    const runId = await t.newRun();

    await expect(t.prepare(runId)).rejects.toMatchObject({ code: "LLM_OUTPUT_INVALID" });
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      llmUsage: { calls: 2, costUsd: expect.closeTo(1.4, 10), requestIds: ["req_1", "req_2"] },
    });
  });

  it("lo cobrado que viaja en un error del proveedor también se anota", async () => {
    const charged = new AppError("LLM_OUTPUT_INVALID", "La IA no entregó los textos", {
      details: { reason: "max_tokens", usage: SPEND, model: "claude-sonnet-5-5" },
    });
    const t = await setup({ ownName: "claude-cli", apiLlm: [{ error: charged }] });
    const runId = await t.newRun();

    await expect(t.prepare(runId)).rejects.toMatchObject({ code: "LLM_OUTPUT_INVALID" });
    expect((await t.contentRepos.contentRuns.get(runId))?.llmUsage).toMatchObject({
      calls: 1,
      costUsd: expect.closeTo(0.7, 10),
    });
  });

  it("sin la clave de la API: LLM_NOT_CONFIGURED con lo que falta, y las imágenes quedan", async () => {
    const t = await setup({ ownName: "claude-cli", llm: [], apiLlm: null });
    const runId = await t.newRun();

    await expect(t.prepare(runId)).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      stage: "texts",
      error: { code: "LLM_NOT_CONFIGURED", message: expect.stringContaining("ANTHROPIC_API_KEY") },
    });
    expect(variantsOf(await t.derivatives(), "cover")).toHaveLength(1);
  });

  it("con el tope del mes alcanzado, el worker hace las imágenes y no llama a la IA", async () => {
    const t = await setup({
      broker: { llmMonthlyCapUsd: 0.5 },
      ownName: "claude-cli",
      apiLlm: [{ data: SAMPLE_CONTENT_DRAFT, model: "claude-sonnet-5-5", usage: SPEND }],
    });
    await t.prepare(await t.newRun());
    const runId = await t.newRun();

    await expect(t.prepare(runId)).rejects.toMatchObject({ code: "LLM_BUDGET_EXCEEDED" });
    expect(await t.contentRepos.contentRuns.get(runId)).toMatchObject({
      status: "failed",
      stage: "texts",
      error: { code: "LLM_BUDGET_EXCEEDED" },
    });
    expect(variantsOf(await t.derivatives(), "cover")).toHaveLength(1);
    expect(t.apiLlm?.requests).toHaveLength(1);
  });
});

describe("prepareContent · el tope antes de cada llamada (F7-T12)", () => {
  it("el reintento revisa el tope otra vez: la primera llamada lo pasó", async () => {
    const t = await setup({
      broker: { llmMonthlyCapUsd: 0.5 },
      ownName: "claude-cli",
      // La primera respuesta no calza y cuesta US$ 0,70: el reintento ya está sobre el tope.
      apiLlm: [
        { data: { no: "calza" }, model: "claude-sonnet-5-5", usage: SPEND },
        { data: SAMPLE_CONTENT_DRAFT, model: "claude-sonnet-5-5", usage: SPEND },
      ],
    });
    const runId = await t.newRun();

    await expect(t.prepare(runId)).rejects.toMatchObject({ code: "LLM_BUDGET_EXCEEDED" });
    expect(t.apiLlm?.requests).toHaveLength(1);
    expect((await t.contentRepos.contentRuns.get(runId))?.llmUsage).toMatchObject({ calls: 1 });
  });
});
