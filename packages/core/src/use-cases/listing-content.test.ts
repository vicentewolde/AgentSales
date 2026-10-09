import { describe, expect, it } from "vitest";
import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import type { NewListing } from "../ports/listing-repository.js";
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
} from "../testing/index.js";
import { editContent } from "./edit-content.js";
import { getListingContent } from "./get-listing-content.js";
import { prepareContent } from "./prepare-content.js";
import { requestContentRun } from "./request-content-run.js";

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

/** Un aviso con 3 fotos y un video, y (si `prepared`) una corrida completa con el proveedor falso. */
async function setup(options: { prepared?: boolean; internalNotes?: string } = {}) {
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const broker = contentBrokerFixture();
  const listings = createInMemoryListingRepository();
  const {
    id: _id,
    status: _s,
    closeReason: _c,
    createdAt: _a,
    updatedAt: _u,
    ...rest
  } = contentListingFixture(
    options.internalNotes === undefined ? {} : { internalNotes: options.internalNotes },
  );
  const listing = await listings.create({
    ...(rest as Omit<NewListing, "sourceHash">),
    sourceHash: "h",
  });
  await listings.promoteToReady(listing.id);
  const originals = [
    { name: "foto-1", kind: "image" as const },
    { name: "foto-2", kind: "image" as const, isCover: true },
    { name: "foto-3", kind: "image" as const },
    { name: "video-1", kind: "video" as const },
  ];
  for (const [index, original] of originals.entries()) {
    const path = `brokers/${broker.id}/listings/${listing.id}/original/${original.name}`;
    const mime = original.kind === "video" ? "video/mp4" : "image/jpeg";
    await storage.put(path, text(original.name), mime);
    await media.create({
      listingId: listing.id,
      brokerId: broker.id,
      kind: original.kind,
      storagePath: path,
      mime,
      bytes: original.name.length,
      checksum: `sha-${original.name}`,
      sortOrder: index,
      isCover: original.isCover ?? false,
    });
  }
  const repos = createInMemoryContentRepositories();
  const brokers = createInMemoryBrokerRepository([broker]);
  const fieldDefinitions = createInMemoryFieldDefinitionRepository(contentDefinitionsFixture());
  const deps = {
    listings,
    brokers,
    fieldDefinitions,
    media,
    contents: repos.contents,
    contentRuns: repos.contentRuns,
  };
  const prepare = async (texts = true) => {
    const run = await repos.contentRuns.create({ listingId: listing.id, texts });
    await prepareContent(
      {
        ...deps,
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
  if (options.prepared ?? true) await prepare();
  const current = async () =>
    (await getListingContent(deps, { listingId: listing.id })).contents.map((item) => item.content);
  const publications = createInMemoryPublicationRepository();
  const lockWith = (lockBrokers = brokers) =>
    createInMemoryListingLock({
      brokers: lockBrokers,
      listings,
      media,
      contentRuns: repos.contentRuns,
      contents: repos.contents,
      publications,
      platformAccounts: createInMemoryPlatformAccountRepository(),
    });
  const lock = lockWith();
  const editDeps = { contents: repos.contents, listings, fieldDefinitions, lock };
  return {
    deps,
    editDeps,
    lock,
    lockWith,
    publications,
    listingId: listing.id,
    repos,
    prepare,
    current,
  };
}

describe("getListingContent", () => {
  it("devuelve el texto vigente de cada canal con su revisión, los medios por canal y la corrida", async () => {
    const t = await setup();

    const result = await getListingContent(t.deps, { listingId: t.listingId });

    expect(result.contents.map(({ content, checks }) => [content.platform, checks])).toEqual([
      ["instagram", []],
      ["portal_inmobiliario", []],
      ["fb_marketplace", []],
    ]);
    // Portada, las 2 fotos que no son la de portada y la ficha.
    expect(result.carousel.map((item) => item.variant)).toEqual([
      "cover",
      "ig_4x5",
      "ig_4x5",
      "spec_sheet",
    ]);
    expect(result.photos.map((item) => item.variant)).toEqual(["pi_4x3", "pi_4x3", "pi_4x3"]);
    expect(result.reel).toMatchObject({ variant: "ig_reel", mime: "video/mp4" });
    expect(result.latestRun).toMatchObject({ status: "succeeded", texts: true });
  });

  it("sin corridas: sin textos, sin medios compuestos y sin corrida", async () => {
    const t = await setup({ prepared: false });

    expect(await getListingContent(t.deps, { listingId: t.listingId })).toEqual({
      contents: [],
      carousel: [],
      photos: [],
      reel: null,
      latestRun: null,
    });
  });

  it("la revisión ve lo privado del aviso: una nota interna copiada en el texto es un error", async () => {
    const notes = "el propietario acepta bajar el precio hasta quinientos";
    const t = await setup({ internalNotes: notes });
    const [instagram] = await t.current();
    await t.repos.contents.update(instagram?.id ?? "", { body: `Atención: ${notes}` });

    const { contents } = await getListingContent(t.deps, { listingId: t.listingId });

    expect(contents[0]?.checks.map((check) => check.code)).toContain("INTERNAL_NOTES_LEAK");
    // El mensaje no cita la nota.
    expect(JSON.stringify(contents[0]?.checks)).not.toContain("quinientos");
  });

  it("un aviso que no existe → LISTING_NOT_FOUND", async () => {
    const t = await setup({ prepared: false });
    await expect(getListingContent(t.deps, { listingId: "nadie" })).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
    });
  });
});

describe("editContent", () => {
  it("edita el vigente: lo deja en edited y devuelve su revisión", async () => {
    const t = await setup();
    const [, portal] = await t.current();

    const result = await editContent(t.editDeps, {
      contentId: portal?.id ?? "",
      edit: { title: "Departamento en venta en Ñuñoa", body: "Increíble departamento." },
    });

    expect(result.content).toMatchObject({
      id: portal?.id,
      status: "edited",
      title: "Departamento en venta en Ñuñoa",
      body: "Increíble departamento.",
    });
    expect(result.checks.map((check) => check.code)).toEqual(["SUPERLATIVE"]);
    expect((await t.current())[1]).toMatchObject({ status: "edited" });
  });

  it("en Instagram normaliza los hashtags y quita vacíos y repetidos", async () => {
    const t = await setup();
    const [instagram] = await t.current();

    const { content } = await editContent(t.editDeps, {
      contentId: instagram?.id ?? "",
      edit: { hashtags: ["Ñuñoa", "#ñuñoa", "  ", "#Depto Venta"] },
    });

    expect(content.hashtags).toEqual(["#nunoa", "#deptoventa"]);
  });

  it("un texto viejo (ya hay uno más nuevo del canal) → CONTENT_NOT_CURRENT", async () => {
    const t = await setup();
    const [old] = await t.current();
    await t.prepare();

    await expect(
      editContent(t.editDeps, { contentId: old?.id ?? "", edit: { body: "nuevo" } }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_CURRENT" });
    expect(await t.repos.contents.get(old?.id ?? "")).toMatchObject({ status: "draft" });
  });

  it("con una corrida de textos activa → CONTENT_RUN_ACTIVE; con una de solo imágenes sí se puede", async () => {
    const t = await setup();
    const [instagram] = await t.current();
    const texts = await t.repos.contentRuns.create({ listingId: t.listingId, texts: true });

    await expect(
      editContent(t.editDeps, { contentId: instagram?.id ?? "", edit: { body: "a mano" } }),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_ACTIVE" });

    await t.repos.contentRuns.markFailed(texts.id, { code: "X", message: "x" });
    await t.repos.contentRuns.create({ listingId: t.listingId, texts: false });
    await expect(
      editContent(t.editDeps, { contentId: instagram?.id ?? "", edit: { body: "a mano" } }),
    ).resolves.toMatchObject({ content: { status: "edited", body: "a mano" } });
  });

  it("título en Instagram o hashtags en Portal → 400; vaciar los de Portal sí se puede", async () => {
    const t = await setup();
    const [instagram, portal] = await t.current();

    await expect(
      editContent(t.editDeps, { contentId: instagram?.id ?? "", edit: { title: "Hola" } }),
    ).rejects.toMatchObject({ code: "CONTENT_TITLE_INVALID" });
    await expect(
      editContent(t.editDeps, { contentId: portal?.id ?? "", edit: { hashtags: ["#nunoa"] } }),
    ).rejects.toMatchObject({ code: "CONTENT_HASHTAGS_INVALID" });
    await expect(
      editContent(t.editDeps, { contentId: portal?.id ?? "", edit: { hashtags: [] } }),
    ).resolves.toMatchObject({ content: { hashtags: [] } });
  });

  it("si falta el corredor, no guarda nada (el contexto se carga antes de escribir)", async () => {
    const t = await setup();
    const [instagram] = await t.current();

    await expect(
      editContent(
        { ...t.editDeps, lock: t.lockWith(createInMemoryBrokerRepository([])) },
        { contentId: instagram?.id ?? "", edit: { body: "a mano" } },
      ),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(await t.repos.contents.get(instagram?.id ?? "")).toMatchObject({ status: "draft" });
  });

  it("un texto con una publicación activa → CONTENT_LOCKED, sin cambiarlo (también publicada)", async () => {
    const t = await setup();
    const [instagram] = await t.current();
    const publication = await t.publications.create(
      {
        listingId: t.listingId,
        platformAccountId: "account-1",
        platform: "instagram",
        format: "post",
        contentId: instagram?.id ?? "",
        mediaIds: [],
        listingSourceHash: "hash",
      },
      { actor: "operator" },
    );
    const edit = () =>
      editContent(t.editDeps, { contentId: instagram?.id ?? "", edit: { body: "a mano" } });

    await expect(edit()).rejects.toMatchObject({
      code: "CONTENT_LOCKED",
      details: { publicationId: publication.id, status: "approved" },
    });
    await t.publications.transition(
      publication.id,
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.publications.transition(
      publication.id,
      { from: "publishing", to: "published" },
      { actor: "system" },
    );
    await expect(edit()).rejects.toMatchObject({ code: "CONTENT_LOCKED" });
    expect(await t.repos.contents.get(instagram?.id ?? "")).toMatchObject({ status: "draft" });

    // Una publicación descartada o retirada ya no lo bloquea.
    await t.publications.transition(
      publication.id,
      { from: "published", to: "unpublished" },
      { actor: "operator" },
    );
    await expect(edit()).resolves.toMatchObject({ content: { status: "edited" } });
  });

  it("un texto aprobado sin publicaciones activas se edita y pierde la aprobación", async () => {
    const t = await setup();
    const [instagram] = await t.current();
    await t.repos.contents.update(instagram?.id ?? "", { status: "approved" });

    await expect(
      editContent(t.editDeps, { contentId: instagram?.id ?? "", edit: { body: "a mano" } }),
    ).resolves.toMatchObject({ content: { status: "edited", body: "a mano" } });
  });

  describe("la ventana de F2 se cerró: un pedido de textos y una edición a la vez", () => {
    /** Un `Deferred`: una promesa que el test resuelve cuando quiere. */
    const deferred = () => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    /** Espera (con tope, en microtareas: core no usa timers de Node) a que `first` llegue a la puerta. */
    const untilBusy = async (busy: () => boolean) => {
      for (let i = 0; i < 1000 && !busy(); i += 1) await Promise.resolve();
      expect(busy()).toBe(true);
    };

    /**
     * Arranca primero `first` y lo detiene **dentro** del candado (en su escritura), lanza `second`
     * mientras tanto y después suelta a `first`. `serialize: false` usa un "candado" que no
     * serializa, para comprobar que el test detecta la falta de candado.
     */
    async function race(first: "edit" | "request", { serialize = true } = {}) {
      const t = await setup();
      const [instagram] = await t.current();
      const gate = deferred();
      let entered = false;
      // Los repositorios del candado, con la escritura de `first` detenida en la puerta.
      const contents = {
        ...t.repos.contents,
        update: async (...args: Parameters<typeof t.repos.contents.update>) => {
          if (first === "edit") {
            entered = true;
            await gate.promise;
          }
          return t.repos.contents.update(...args);
        },
      };
      const contentRuns = {
        ...t.repos.contentRuns,
        create: async (...args: Parameters<typeof t.repos.contentRuns.create>) => {
          if (first === "request") {
            entered = true;
            await gate.promise;
          }
          return t.repos.contentRuns.create(...args);
        },
      };
      const locked = {
        brokers: createInMemoryBrokerRepository([contentBrokerFixture()]),
        listings: t.deps.listings,
        media: t.deps.media,
        contentRuns,
        contents,
        publications: t.publications,
        platformAccounts: createInMemoryPlatformAccountRepository(),
      };
      const lock = serialize
        ? createInMemoryListingLock(locked)
        : { run: <T>(_id: string, fn: (repos: typeof locked) => Promise<T>) => fn(locked) };
      const startEdit = () =>
        editContent(
          { ...t.editDeps, lock },
          { contentId: instagram?.id ?? "", edit: { body: "a mano" } },
        );
      const startRequest = () =>
        requestContentRun(
          { lock, contentRuns: t.repos.contentRuns, queue: createInMemoryJobQueue() },
          { listingId: t.listingId },
        );

      const firstCall = first === "edit" ? startEdit() : startRequest();
      await untilBusy(() => entered);
      const secondCall = first === "edit" ? startRequest() : startEdit();
      // Que `second` alcance a llegar al candado (o, sin candado, a su escritura) antes de soltar.
      for (let i = 0; i < 1000; i += 1) await Promise.resolve();
      gate.resolve();
      const [a, b] = await Promise.allSettled([firstCall, secondCall]);
      const code = (result: PromiseSettledResult<unknown>) =>
        result.status === "fulfilled" ? "ok" : (result.reason as { code: string }).code;
      const [edit, request] = first === "edit" ? [code(a), code(b)] : [code(b), code(a)];
      const body = (await t.repos.contents.get(instagram?.id ?? ""))?.body;
      return { edit, request, body };
    }

    it("si la edición entra primero, el pedido avisa con CONTENT_EDITED y la edición queda", async () => {
      expect(await race("edit")).toEqual({
        edit: "ok",
        request: "CONTENT_EDITED",
        body: "a mano",
      });
    });

    it("si el pedido entra primero, la edición espera la corrida (CONTENT_RUN_ACTIVE)", async () => {
      expect(await race("request")).toMatchObject({ edit: "CONTENT_RUN_ACTIVE", request: "ok" });
    });

    it("sin candado, las dos pasan y la corrida pisaría la edición (el test lo detecta)", async () => {
      expect(await race("edit", { serialize: false })).toMatchObject({ edit: "ok", request: "ok" });
    });
  });

  it("un texto que no existe → CONTENT_NOT_FOUND", async () => {
    const t = await setup();
    await expect(
      editContent(t.editDeps, { contentId: "nadie", edit: { body: "x" } }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });
});
