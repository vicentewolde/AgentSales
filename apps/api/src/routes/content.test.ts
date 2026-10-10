import { randomUUID } from "node:crypto";
import {
  AppError,
  CONTENT_PROMPT_VERSION,
  type NewListing,
  prepareContent,
  SAMPLE_CONTENT_DRAFT,
} from "@agentsales/core";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryHtmlRenderer,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
  createInMemorySlideTemplates,
  fakeHash,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  contentEditResponseSchema,
  contentRunRequestResponseSchema,
  contentRunResponseSchema,
  errorBodySchema,
  listingContentResponseSchema,
  listingDetailResponseSchema,
  listingListResponseSchema,
} from "../contracts/index.js";
import { testDeps } from "../testing/index.js";

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));
const ADDRESS = "Calle Secreta 4321";
const NOTES = "el propietario acepta bajar hasta cinco mil quinientos";

/**
 * Un aviso inventado con 2 fotos y un video, en memoria, servido por la API. `prepare` corre una
 * corrida completa con dobles (lo que hará el worker).
 */
async function setup(options: { queueDown?: boolean } = {}) {
  const listings = createInMemoryListingRepository({ nextId: randomUUID });
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const fieldDefinitions = createInMemoryFieldDefinitionRepository(contentDefinitionsFixture());
  const repos = createInMemoryContentRepositories({ nextId: randomUUID });
  const queue = createInMemoryJobQueue({
    fail: () =>
      options.queueDown
        ? new AppError("QUEUE_UNAVAILABLE", "No se pudo conectar a la cola", { retriable: true })
        : undefined,
  });
  const {
    id: _id,
    status: _s,
    closeReason: _c,
    createdAt: _a,
    updatedAt: _u,
    ...rest
  } = contentListingFixture({ address: ADDRESS, internalNotes: NOTES });
  const listing = await listings.create({
    ...(rest as Omit<NewListing, "sourceHash">),
    sourceHash: "h",
  });
  await listings.promoteToReady(listing.id);
  for (const [index, name] of ["foto-1.heic", "foto-2.jpg", "video-1.mp4"].entries()) {
    const kind = name.startsWith("video") ? ("video" as const) : ("image" as const);
    const mime =
      kind === "video" ? "video/mp4" : name.endsWith(".heic") ? "image/heic" : "image/jpeg";
    const path = `brokers/${broker.id}/listings/${listing.id}/original/${name}`;
    await storage.put(path, text(name), mime);
    await media.create({
      listingId: listing.id,
      brokerId: broker.id,
      kind,
      storagePath: path,
      mime,
      bytes: name.length,
      checksum: `sha-${name}`,
      sortOrder: index,
      isCover: index === 0,
    });
  }
  const publications = createInMemoryPublicationRepository();
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns: repos.contentRuns,
    contents: repos.contents,
    publications,
    platformAccounts: createInMemoryPlatformAccountRepository(),
  });
  const app = createApp(
    testDeps({
      listings,
      brokers,
      media,
      fieldDefinitions,
      contentRuns: repos.contentRuns,
      contents: repos.contents,
      queue,
      lock,
    }),
  );
  /** Una publicación aprobada (pendiente) del texto de Instagram, como la deja `approveContent`. */
  const approvedPublication = async (contentId: string) =>
    publications.create(
      {
        listingId: listing.id,
        platformAccountId: randomUUID(),
        platform: "instagram",
        format: "post",
        contentId,
        mediaIds: [],
        listingSourceHash: "hash",
      },
      { actor: "operator" },
    );
  const prepare = async () => {
    const run = await repos.contentRuns.create({ listingId: listing.id, texts: true });
    await prepareContent(
      {
        contentRuns: repos.contentRuns,
        listings,
        brokers,
        fieldDefinitions,
        media,
        storage,
        processor: createInMemoryMediaProcessor(),
        templates: createInMemorySlideTemplates(),
        renderer: createInMemoryHtmlRenderer(),
        llm: createInMemoryLlmProvider([{ data: SAMPLE_CONTENT_DRAFT }]),
        sha256: fakeHash,
      },
      { contentRunId: run.id, isLastAttempt: true },
    );
    return run.id;
  };
  const json = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const request = (body: unknown = {}) =>
    json("POST", `/listings/${listing.id}/content-runs`, body);
  const content = async () =>
    listingContentResponseSchema.parse(
      await (await app.request(`/listings/${listing.id}/content`)).json(),
    );
  return {
    app,
    listings,
    listing,
    repos,
    queue,
    prepare,
    json,
    request,
    content,
    approvedPublication,
  };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json());

describe("testDeps · el candado por defecto", () => {
  it("usa los mismos repositorios que la app, también los que llegan por overrides", async () => {
    const listings = createInMemoryListingRepository({ nextId: randomUUID });
    const media = createInMemoryMediaRepository();
    const repos = createInMemoryContentRepositories({ nextId: randomUUID });
    const queue = createInMemoryJobQueue();
    const listing = await listings.create({
      ...(contentListingFixture() as unknown as NewListing),
      sourceHash: "h",
    });
    await listings.promoteToReady(listing.id);
    await media.create({
      listingId: listing.id,
      brokerId: contentListingFixture().brokerId,
      kind: "image",
      storagePath: "foto.jpg",
      mime: "image/jpeg",
      bytes: 1,
      checksum: "sha-foto",
      sortOrder: 0,
      isCover: true,
    });
    // Sin `lock`: lo arma `testDeps` sobre estos repositorios. Si usara otros, el aviso no existiría.
    const app = createApp(
      testDeps({
        listings,
        media,
        contentRuns: repos.contentRuns,
        contents: repos.contents,
        queue,
      }),
    );

    const response = await app.request(`/listings/${listing.id}/content-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(202);
    expect(await repos.contentRuns.latest(listing.id)).toMatchObject({ status: "queued" });
  });
});

describe("POST /listings/:id/content-runs · publicaciones pendientes (F3)", () => {
  it("con una publicación aprobada que no salió es 409 PUBLICATION_PENDING, también sin textos", async () => {
    const t = await setup();
    await t.prepare();
    const [instagram] = (await t.content()).contents;
    await t.approvedPublication(instagram?.id ?? "");

    for (const body of [{}, { texts: false }, { replaceEdits: true }]) {
      const blocked = await t.request(body);
      expect(blocked.status).toBe(409);
      expect((await errorOf(blocked)).error.code).toBe("PUBLICATION_PENDING");
    }
    expect(t.queue.jobs).toEqual([]);
  });
});

describe("POST /listings/:id/content-runs", () => {
  it("crea la corrida (202) y encola; un segundo pedido devuelve la misma con reused", async () => {
    const t = await setup();

    const first = await t.request({ texts: false });
    expect(first.status).toBe(202);
    const created = contentRunRequestResponseSchema.parse(await first.json());
    expect(created).toMatchObject({
      reused: false,
      contentRun: { status: "queued", texts: false, listingId: t.listing.id },
    });
    expect(t.queue.jobs).toEqual([
      {
        name: "content.prepare",
        data: { contentRunId: created.contentRun.id },
        options: { singletonKey: created.contentRun.id },
      },
    ]);

    const again = contentRunRequestResponseSchema.parse(await (await t.request()).json());
    expect(again).toMatchObject({ reused: true, contentRun: { id: created.contentRun.id } });
  });

  it("un aviso que no está listo es 409 LISTING_NOT_READY", async () => {
    const t = await setup();
    t.listings.setStatus(t.listing.id, "draft");

    const response = await t.request();
    expect(response.status).toBe(409);
    expect((await errorOf(response)).error.code).toBe("LISTING_NOT_READY");
  });

  it("con un texto editado a mano es 409 CONTENT_EDITED; con replaceEdits se pide igual", async () => {
    const t = await setup();
    await t.prepare();
    const [instagram] = (await t.content()).contents;
    await t.json("PATCH", `/contents/${instagram?.id}`, { body: "Lo escribí yo." });

    const blocked = await t.request();
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).error.code).toBe("CONTENT_EDITED");

    expect((await t.request({ replaceEdits: true })).status).toBe(202);
  });

  it("con la cola caída es 503 QUEUE_UNAVAILABLE y la corrida queda en failed", async () => {
    const t = await setup({ queueDown: true });

    const response = await t.request();
    expect(response.status).toBe(503);
    expect((await errorOf(response)).error.code).toBe("QUEUE_UNAVAILABLE");
    expect(await t.repos.contentRuns.latest(t.listing.id)).toMatchObject({ status: "failed" });
  });

  it("un cuerpo inválido es 400 REQUEST_INVALID; un aviso que no existe, 404", async () => {
    const t = await setup();
    const invalid = await t.request({ texts: "sí" });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).error.code).toBe("REQUEST_INVALID");

    const missing = await t.json("POST", `/listings/${randomUUID()}/content-runs`, {});
    expect(missing.status).toBe(404);
  });
});

describe("GET /content-runs/:id", () => {
  it("devuelve estado, etapa y reporte; una que no existe es 404", async () => {
    const t = await setup();
    const runId = await t.prepare();

    const response = await t.app.request(`/content-runs/${runId}`);
    expect(response.status).toBe(200);
    const { contentRun } = contentRunResponseSchema.parse(await response.json());
    expect(contentRun).toMatchObject({
      id: runId,
      status: "succeeded",
      stage: "texts",
      report: { media: { processed: 3 }, reel: "created" },
      error: null,
    });
    expect(contentRun.finishedAt).toBeInstanceOf(Date);
    // La llamada a la IA sin proveedor ni modelo, como la vista del texto.
    expect(contentRun.report?.llm).toEqual({
      promptVersion: CONTENT_PROMPT_VERSION,
      attempts: 1,
      durationMs: expect.any(Number),
    });

    const missing = await t.app.request(`/content-runs/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).error.code).toBe("CONTENT_RUN_NOT_FOUND");
  });
});

describe("GET /listings/:id/content", () => {
  it("devuelve los textos con sus checks, los medios con URLs firmadas y la corrida", async () => {
    const t = await setup();
    await t.prepare();

    const response = await t.app.request(`/listings/${t.listing.id}/content`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = listingContentResponseSchema.parse(JSON.parse(raw));

    expect(body.contents.map((item) => [item.platform, item.status, item.checks])).toEqual([
      ["instagram", "draft", []],
      ["portal_inmobiliario", "draft", []],
      ["fb_marketplace", "draft", []],
    ]);
    expect(body.carousel.map((item) => item.variant)).toEqual(["cover", "ig_4x5", "spec_sheet"]);
    expect(body.photos.map((item) => item.variant)).toEqual(["pi_4x3", "pi_4x3"]);
    expect(body.reel).toMatchObject({ variant: "ig_reel", mime: "video/mp4" });
    for (const item of [...body.carousel, ...body.photos]) {
      expect(item.url).toMatch(/^https:\/\/r2\.test\/brokers\/.+\?firma$/);
    }
    expect(body.latestRun).toMatchObject({ status: "succeeded" });
    // Ni la salida cruda ni el modelo, ni lo privado del aviso.
    expect(raw).not.toContain("rawOutput");
    expect(raw).not.toContain("llmModel");
    expect(raw).not.toContain("modelo-falso");
    expect(raw).not.toMatch(/"(provider|model|llmProvider)"/);
    expect(raw).not.toContain("Secreta");
    expect(raw).not.toContain("quinientos");
  });

  it("un texto con una fuga trae el error en checks, sin citar lo privado", async () => {
    const t = await setup();
    await t.prepare();
    const [, portal] = (await t.content()).contents;
    await t.json("PATCH", `/contents/${portal?.id}`, { body: `Queda en ${ADDRESS}.` });

    const [, after] = (await t.content()).contents;
    expect(after?.checks.map((check) => check.code)).toContain("ADDRESS_EXPOSED");
    expect(JSON.stringify(after?.checks)).not.toContain("Secreta");
  });

  it("sin corridas: listas vacías; un aviso que no existe es 404", async () => {
    const t = await setup();
    expect(await t.content()).toEqual({
      contents: [],
      carousel: [],
      photos: [],
      reel: null,
      latestRun: null,
      // Lo que le falta al aviso para Portal (F4-T19): la lista completa, con su motivo.
      portalReadiness: { ready: true, issues: [] },
      // Lo que le falta para Marketplace (F5-T08): sin fotos, y el precio en UF sin el token.
      marketplaceReadiness: {
        ready: false,
        issues: [
          expect.objectContaining({ code: "MARKETPLACE_PHOTOS_MISSING", field: null }),
          expect.objectContaining({ code: "UF_SOURCE_NOT_CONFIGURED", field: null }),
        ],
      },
    });
    expect((await t.app.request(`/listings/${randomUUID()}/content`)).status).toBe(404);
  });
});

describe("PATCH /contents/:id", () => {
  it("edita el vigente y responde con su revisión", async () => {
    const t = await setup();
    await t.prepare();
    const [instagram] = (await t.content()).contents;

    const response = await t.json("PATCH", `/contents/${instagram?.id}`, {
      body: "El mejor departamento de Ñuñoa.",
      hashtags: ["Ñuñoa", "#ñuñoa"],
    });
    expect(response.status).toBe(200);
    const { content } = contentEditResponseSchema.parse(await response.json());
    expect(content).toMatchObject({
      id: instagram?.id,
      status: "edited",
      body: "El mejor departamento de Ñuñoa.",
      hashtags: ["#nunoa"],
    });
    expect(content.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(["HASHTAG_COUNT"]),
    );
  });

  it("un cuerpo vacío o inválido es 400; un id que no existe, 404", async () => {
    const t = await setup();
    await t.prepare();
    const [instagram] = (await t.content()).contents;

    for (const body of [{}, { body: "   " }, { hashtags: "nunoa" }]) {
      const response = await t.json("PATCH", `/contents/${instagram?.id}`, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).error.code).toBe("REQUEST_INVALID");
    }
    const missing = await t.json("PATCH", `/contents/${randomUUID()}`, { body: "x" });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).error.code).toBe("CONTENT_NOT_FOUND");
  });

  it("con una corrida de textos activa es 409 CONTENT_RUN_ACTIVE; un texto viejo, CONTENT_NOT_CURRENT", async () => {
    const t = await setup();
    await t.prepare();
    const [old] = (await t.content()).contents;

    await t.request();
    const active = await t.json("PATCH", `/contents/${old?.id}`, { body: "x" });
    expect(active.status).toBe(409);
    expect((await errorOf(active)).error.code).toBe("CONTENT_RUN_ACTIVE");

    const queued = await t.repos.contentRuns.latest(t.listing.id);
    await t.repos.contentRuns.markFailed(queued?.id ?? "", { code: "X", message: "x" });
    await t.prepare();
    const stale = await t.json("PATCH", `/contents/${old?.id}`, { body: "x" });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe("CONTENT_NOT_CURRENT");
  });

  it("un texto con una publicación activa es 409 CONTENT_LOCKED (ADR-0014)", async () => {
    const t = await setup();
    await t.prepare();
    const [instagram] = (await t.content()).contents;
    await t.approvedPublication(instagram?.id ?? "");

    const locked = await t.json("PATCH", `/contents/${instagram?.id}`, { body: "x" });
    expect(locked.status).toBe(409);
    expect((await errorOf(locked)).error.code).toBe("CONTENT_LOCKED");
  });

  it("hashtags en Portal o un título en Instagram son 400", async () => {
    const t = await setup();
    await t.prepare();
    const [instagram, portal] = (await t.content()).contents;

    const title = await t.json("PATCH", `/contents/${instagram?.id}`, { title: "Hola" });
    expect(title.status).toBe(400);
    expect((await errorOf(title)).error.code).toBe("CONTENT_TITLE_INVALID");

    const response = await t.json("PATCH", `/contents/${portal?.id}`, { hashtags: ["#nunoa"] });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error.code).toBe("CONTENT_HASHTAGS_INVALID");
  });
});

describe("miniaturas en /listings (F2-T12)", () => {
  it("el detalle trae thumbUrl y medidas de cada original; la lista usa la miniatura de la portada", async () => {
    const t = await setup();

    const before = listingDetailResponseSchema.parse(
      await (await t.app.request(`/listings/${t.listing.id}`)).json(),
    );
    expect(before.media.map((item) => [item.thumbUrl, item.width])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);

    await t.prepare();
    const detail = listingDetailResponseSchema.parse(
      await (await t.app.request(`/listings/${t.listing.id}`)).json(),
    );
    expect(detail.media).toHaveLength(3); // solo originales
    for (const item of detail.media) {
      expect(item.thumbUrl).toMatch(/\/processed\/thumb\/.+\?firma$/);
      expect(item.width).toBeGreaterThan(0);
    }
    expect(detail.media[2]?.durationS).toBeGreaterThan(0);

    const list = listingListResponseSchema.parse(await (await t.app.request("/listings")).json());
    // La portada es un HEIC: la lista muestra su miniatura JPEG.
    expect(list.listings[0]?.coverUrl).toMatch(/\/processed\/thumb\/.+\?firma$/);
  });
});
