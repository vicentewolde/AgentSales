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
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemorySlideTemplates,
  fakeHash,
} from "../testing/index.js";
import { editContent } from "./edit-content.js";
import { getListingContent } from "./get-listing-content.js";
import { prepareContent } from "./prepare-content.js";

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
  return { deps, listingId: listing.id, repos, prepare, current };
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

    const result = await editContent(t.deps, {
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

    const { content } = await editContent(t.deps, {
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
      editContent(t.deps, { contentId: old?.id ?? "", edit: { body: "nuevo" } }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_CURRENT" });
    expect(await t.repos.contents.get(old?.id ?? "")).toMatchObject({ status: "draft" });
  });

  it("con una corrida de textos activa → CONTENT_RUN_ACTIVE; con una de solo imágenes sí se puede", async () => {
    const t = await setup();
    const [instagram] = await t.current();
    const texts = await t.repos.contentRuns.create({ listingId: t.listingId, texts: true });

    await expect(
      editContent(t.deps, { contentId: instagram?.id ?? "", edit: { body: "a mano" } }),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_ACTIVE" });

    await t.repos.contentRuns.markFailed(texts.id, { code: "X", message: "x" });
    await t.repos.contentRuns.create({ listingId: t.listingId, texts: false });
    await expect(
      editContent(t.deps, { contentId: instagram?.id ?? "", edit: { body: "a mano" } }),
    ).resolves.toMatchObject({ content: { status: "edited", body: "a mano" } });
  });

  it("título en Instagram o hashtags en Portal → 400; vaciar los de Portal sí se puede", async () => {
    const t = await setup();
    const [instagram, portal] = await t.current();

    await expect(
      editContent(t.deps, { contentId: instagram?.id ?? "", edit: { title: "Hola" } }),
    ).rejects.toMatchObject({ code: "CONTENT_TITLE_INVALID" });
    await expect(
      editContent(t.deps, { contentId: portal?.id ?? "", edit: { hashtags: ["#nunoa"] } }),
    ).rejects.toMatchObject({ code: "CONTENT_HASHTAGS_INVALID" });
    await expect(
      editContent(t.deps, { contentId: portal?.id ?? "", edit: { hashtags: [] } }),
    ).resolves.toMatchObject({ content: { hashtags: [] } });
  });

  it("un texto que no existe → CONTENT_NOT_FOUND", async () => {
    const t = await setup();
    await expect(
      editContent(t.deps, { contentId: "nadie", edit: { body: "x" } }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });
});
