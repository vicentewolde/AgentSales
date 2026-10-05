import { describe, expect, it } from "vitest";
import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { NewListing } from "../ports/listing-repository.js";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryHtmlRenderer,
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
import { approveContent } from "./approve-content.js";
import { getListingContent } from "./get-listing-content.js";
import { publicationPlan } from "./open-publications.js";
import { prepareContent } from "./prepare-content.js";
import { unapproveContent } from "./unapprove-content.js";

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

/** Un aviso `ready` con 3 fotos y un video, preparado con el proveedor falso (carrusel y reel). */
async function setup(options: { account?: boolean; processed?: boolean } = {}) {
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
  } = contentListingFixture();
  const listing = await listings.create({
    ...(rest as Omit<NewListing, "sourceHash">),
    sourceHash: "h",
  });
  await listings.promoteToReady(listing.id);
  const originals = [
    { name: "foto-1", kind: "image" as const, isCover: true },
    { name: "foto-2", kind: "image" as const },
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
  const { contents, contentRuns } = createInMemoryContentRepositories();
  const brokers = createInMemoryBrokerRepository([broker]);
  const fieldDefinitions = createInMemoryFieldDefinitionRepository(contentDefinitionsFixture());
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const publications = createInMemoryPublicationRepository();
  const locked: LockedRepositories = {
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  };
  const lock = createInMemoryListingLock(locked);
  const prepare = async () => {
    const run = await contentRuns.create({ listingId: listing.id, texts: true });
    await prepareContent(
      {
        listings,
        brokers,
        fieldDefinitions,
        media,
        contentRuns,
        storage,
        processor: createInMemoryMediaProcessor(),
        templates: createInMemorySlideTemplates(),
        renderer: createInMemoryHtmlRenderer(),
        llm: createInMemoryLlmProvider([{ data: SAMPLE_CONTENT_DRAFT }]),
        sha256: fakeHash,
      },
      { contentRunId: run.id, isLastAttempt: true },
    );
  };
  if (options.processed === false) {
    // Textos sin medios procesados: una corrida que solo guarda los textos.
    const run = await contentRuns.create({ listingId: listing.id, texts: true });
    await contentRuns.markRunning(run.id);
    await contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: [
        {
          platform: "instagram",
          title: null,
          body: "Departamento en venta",
          hashtags: ["#nunoa"],
          llmProvider: "fake",
          llmModel: "fake",
          promptVersion: "listing-content-v1",
          rawOutput: null,
        },
      ],
    });
  } else {
    await prepare();
  }
  const account =
    options.account === false
      ? null
      : await platformAccounts.upsertConnected({
          brokerId: broker.id,
          platform: "instagram",
          externalAccountId: "17841400000000001",
          displayName: "@muestra",
          tokenExpiresAt: null,
          meta: {},
          credentials: { accessToken: "IGAA-prueba" },
        });
  // Lo que se usa antes del candado: falla si se llama dentro (`fn` solo usa lo del candado).
  let insideLock = false;
  const outside = <T extends object>(repo: T): T =>
    new Proxy(repo, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (insideLock) throw new Error(`${String(key)} se llamó dentro del candado`);
          return value.apply(target, args);
        };
      },
    });
  const watchedLock: ListingLock = {
    async run(listingId, fn) {
      return lock.run(listingId, async (repos) => {
        insideLock = true;
        try {
          return await fn(repos);
        } finally {
          insideLock = false;
        }
      });
    },
  };
  const deps = {
    contents: outside(contents),
    listings: outside(listings),
    fieldDefinitions: outside(fieldDefinitions),
    lock: watchedLock,
  };
  const view = () =>
    getListingContent(
      { listings, brokers, fieldDefinitions, media, contents, contentRuns },
      { listingId: listing.id },
    );
  const currentId = async (platform: string) =>
    (await contents.listCurrent(listing.id)).find((item) => item.platform === platform)?.id ?? "";
  return {
    deps,
    locked,
    listingId: listing.id,
    account,
    prepare,
    view,
    currentId,
  };
}

describe("approveContent", () => {
  it("aprueba el texto de Instagram y abre carrusel y reel con sus medios fijos", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");

    const result = await approveContent(t.deps, { contentId, actor: "operator" });

    expect(result.content).toMatchObject({ id: contentId, status: "approved" });
    expect(result.checks.every((check) => check.severity !== "error")).toBe(true);
    const { carousel, reel } = await t.view();
    expect(result.created.map((publication) => [publication.format, publication.mediaIds])).toEqual(
      [
        ["post", carousel.map((item) => item.id)],
        ["reel", [reel?.id]],
      ],
    );
    expect(result.created.every((publication) => publication.status === "approved")).toBe(true);
    expect(result.created.every((publication) => publication.contentId === contentId)).toBe(true);
    expect(
      result.created.every((publication) => publication.platformAccountId === t.account?.id),
    ).toBe(true);
    expect(result.skipped).toEqual([]);
    const [birth] = await t.locked.publications.listEvents(result.created[0]?.id ?? "");
    expect(birth).toMatchObject({ toStatus: "approved", actor: "operator" });
  });

  it("sin cuenta conectada solo aprueba el texto", async () => {
    const t = await setup({ account: false });
    const contentId = await t.currentId("instagram");

    const result = await approveContent(t.deps, { contentId, actor: "cli" });

    expect(result.content.status).toBe("approved");
    expect(result.created).toEqual([]);
    expect(await t.locked.publications.listByListing(t.listingId)).toEqual([]);
  });

  it.each(["expired", "error"] as const)(
    "una cuenta en %s no recibe publicaciones",
    async (status) => {
      const t = await setup();
      await t.locked.platformAccounts.changeStatus(t.account?.id ?? "", "connected", status);

      const result = await approveContent(t.deps, {
        contentId: await t.currentId("instagram"),
        actor: "operator",
      });

      expect(result.content.status).toBe("approved");
      expect(result.created).toEqual([]);
    },
  );

  it("una cuenta desconectada no recibe publicaciones", async () => {
    const t = await setup();
    await t.locked.platformAccounts.disconnect(t.account?.id ?? "");

    const result = await approveContent(t.deps, {
      contentId: await t.currentId("instagram"),
      actor: "operator",
    });

    expect(result.created).toEqual([]);
  });

  it("los textos de Portal se aprueban aunque no haya cuenta de ese canal", async () => {
    const t = await setup();

    const result = await approveContent(t.deps, {
      contentId: await t.currentId("portal_inmobiliario"),
      actor: "operator",
    });

    expect(result.content.status).toBe("approved");
    expect(result.created).toEqual([]);
  });

  it("aprobar de nuevo no duplica: sus publicaciones ya están (sin informarlas como saltadas)", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    const first = await approveContent(t.deps, { contentId, actor: "operator" });

    const again = await approveContent(t.deps, { contentId, actor: "operator" });

    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([]);
    expect(again.publications.map((publication) => publication.id)).toEqual(
      first.created.map((publication) => publication.id),
    );
  });

  it("devuelve todas las publicaciones del canal, leídas después de aprobar", async () => {
    const t = await setup();
    const result = await approveContent(t.deps, {
      contentId: await t.currentId("instagram"),
      actor: "operator",
    });

    expect(result.publications).toEqual(result.created);
    expect(result.publications.every((publication) => publication.platform === "instagram")).toBe(
      true,
    );
  });

  it("con cuenta conectada y sin fotos procesadas es CONTENT_NOT_READY, sin aprobar el texto", async () => {
    const t = await setup({ processed: false });
    const contentId = await t.currentId("instagram");

    await expect(approveContent(t.deps, { contentId, actor: "operator" })).rejects.toMatchObject({
      code: "CONTENT_NOT_READY",
    });
    expect((await t.locked.contents.get(contentId))?.status).toBe("draft");
    expect(await t.locked.publications.listByListing(t.listingId)).toEqual([]);
  });

  it("sin cuenta conectada aprueba aunque falten las fotos (no hay nada que abrir)", async () => {
    const t = await setup({ processed: false, account: false });

    const result = await approveContent(t.deps, {
      contentId: await t.currentId("instagram"),
      actor: "operator",
    });

    expect(result.content.status).toBe("approved");
  });

  it("un texto nuevo con el carrusel anterior publicado salta ese formato (sin chocar)", async () => {
    const t = await setup();
    const first = await approveContent(t.deps, {
      contentId: await t.currentId("instagram"),
      actor: "operator",
    });
    const post = first.created.find((publication) => publication.format === "post");
    const reel = first.created.find((publication) => publication.format === "reel");
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "publishing", to: "published" },
      { actor: "system" },
    );
    await t.locked.publications.transition(
      reel?.id ?? "",
      { from: "approved", to: "cancelled" },
      { actor: "operator" },
    );
    await t.prepare();
    const newContentId = await t.currentId("instagram");

    const result = await approveContent(t.deps, { contentId: newContentId, actor: "operator" });

    expect(result.content).toMatchObject({ id: newContentId, status: "approved" });
    expect(result.skipped).toEqual([
      { platformAccountId: t.account?.id, format: "post", publicationId: post?.id },
    ]);
    expect(result.created.map((publication) => publication.format)).toEqual(["reel"]);
  });

  it("un texto que no es el vigente es CONTENT_NOT_CURRENT, sin aprobar nada", async () => {
    const t = await setup();
    const old = await t.currentId("instagram");
    await t.prepare();

    await expect(
      approveContent(t.deps, { contentId: old, actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_CURRENT" });
    expect((await t.locked.contents.get(old))?.status).toBe("draft");
  });

  it("con una corrida activa es CONTENT_RUN_ACTIVE", async () => {
    const t = await setup();
    await t.locked.contentRuns.create({ listingId: t.listingId, texts: false });

    await expect(
      approveContent(t.deps, { contentId: await t.currentId("instagram"), actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_ACTIVE" });
  });

  it("con errores en la revisión es CONTENT_HAS_ERRORS, sin aprobar ni abrir", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    await t.locked.contents.update(contentId, {
      body: "Departamento con 99 estacionamientos",
      status: "edited",
    });

    await expect(approveContent(t.deps, { contentId, actor: "operator" })).rejects.toMatchObject({
      code: "CONTENT_HAS_ERRORS",
      details: expect.objectContaining({ codes: expect.arrayContaining(["NUMBER_NOT_IN_DATA"]) }),
    });
    expect((await t.locked.contents.get(contentId))?.status).toBe("edited");
    expect(await t.locked.publications.listByListing(t.listingId)).toEqual([]);
  });

  it("un aviso archivado es LISTING_NOT_READY; uno pausado se puede aprobar", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    await t.locked.listings.changeStatus(t.listingId, "ready", "archived");
    await expect(approveContent(t.deps, { contentId, actor: "operator" })).rejects.toMatchObject({
      code: "LISTING_NOT_READY",
    });

    await t.locked.listings.changeStatus(t.listingId, "archived", "ready");
    await t.locked.listings.changeStatus(t.listingId, "ready", "paused");
    await expect(approveContent(t.deps, { contentId, actor: "operator" })).resolves.toMatchObject({
      content: { status: "approved" },
    });
  });

  it("un texto que no existe es CONTENT_NOT_FOUND", async () => {
    const t = await setup();
    await expect(
      approveContent(t.deps, { contentId: "no-existe", actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });
});

describe("publicationPlan", () => {
  it("sin medios procesados es CONTENT_NOT_READY", () => {
    expect(() => publicationPlan("instagram", [])).toThrow(
      expect.objectContaining({ code: "CONTENT_NOT_READY" }),
    );
  });

  it("Portal y Marketplace dan solo post, con las fotos 4:3", async () => {
    const t = await setup();
    const media = await t.locked.media.listByListing(t.listingId);
    const { photos } = await t.view();

    for (const platform of ["portal_inmobiliario", "fb_marketplace"] as const) {
      expect(publicationPlan(platform, media)).toEqual([
        { format: "post", mediaIds: photos.map((item) => item.id) },
      ]);
    }
  });
});

describe("unapproveContent", () => {
  it("deja el texto editado y descarta las publicaciones que no salieron", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    const approved = await approveContent(t.deps, { contentId, actor: "operator" });

    const result = await unapproveContent(t.deps, { contentId, actor: "cli" });

    expect(result.content).toMatchObject({ id: contentId, status: "edited" });
    expect(result.cancelled.map((publication) => publication.id)).toEqual(
      approved.created.map((publication) => publication.id),
    );
    expect(
      (await t.locked.publications.listByListing(t.listingId)).map((item) => item.status),
    ).toEqual(["cancelled", "cancelled"]);
    const events = await t.locked.publications.listEvents(approved.created[0]?.id ?? "");
    expect(events.at(-1)).toMatchObject({
      toStatus: "cancelled",
      actor: "cli",
      payload: { reason: "unapproved", contentId },
    });
  });

  it("con una publicación publicándose es PUBLICATION_IN_PROGRESS, sin cambiar nada", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    const approved = await approveContent(t.deps, { contentId, actor: "operator" });
    const post = approved.created.find((publication) => publication.format === "post");
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );

    await expect(unapproveContent(t.deps, { contentId, actor: "operator" })).rejects.toMatchObject({
      code: "PUBLICATION_IN_PROGRESS",
    });
    expect((await t.locked.contents.get(contentId))?.status).toBe("approved");
    expect(
      (await t.locked.publications.listByListing(t.listingId)).map((item) => item.status),
    ).toEqual(["publishing", "approved"]);
  });

  it("una publicada no cambia", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    const approved = await approveContent(t.deps, { contentId, actor: "operator" });
    const post = approved.created.find((publication) => publication.format === "post");
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "publishing", to: "published" },
      { actor: "system" },
    );

    const result = await unapproveContent(t.deps, { contentId, actor: "operator" });

    expect(result.cancelled.map((publication) => publication.format)).toEqual(["reel"]);
    expect((await t.locked.publications.get(post?.id ?? ""))?.status).toBe("published");
  });

  it("cancela también las fallidas y las programadas de ese texto", async () => {
    const t = await setup();
    const contentId = await t.currentId("instagram");
    const approved = await approveContent(t.deps, { contentId, actor: "operator" });
    const [post, reel] = approved.created;
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true } },
      { actor: "system" },
    );
    await t.locked.publications.transition(
      post?.id ?? "",
      { from: "publishing", to: "failed" },
      { actor: "system" },
    );
    await t.locked.publications.transition(
      reel?.id ?? "",
      { from: "approved", to: "scheduled" },
      { actor: "operator" },
    );

    const result = await unapproveContent(t.deps, { contentId, actor: "operator" });

    expect(result.cancelled.map((publication) => publication.id)).toEqual([post?.id, reel?.id]);
    expect(result.publications.every((publication) => publication.status === "cancelled")).toBe(
      true,
    );
  });

  it("un texto que no existe es CONTENT_NOT_FOUND, y uno que no es el vigente CONTENT_NOT_CURRENT", async () => {
    const t = await setup();
    await expect(
      unapproveContent(t.deps, { contentId: "no-existe", actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });

    const old = await t.currentId("instagram");
    await approveContent(t.deps, { contentId: old, actor: "operator" });
    await t.prepare();
    await expect(
      unapproveContent(t.deps, { contentId: old, actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_CURRENT" });
    expect((await t.locked.contents.get(old))?.status).toBe("approved");
  });

  it("un texto que no está aprobado es CONTENT_NOT_APPROVED", async () => {
    const t = await setup();
    await expect(
      unapproveContent(t.deps, { contentId: await t.currentId("instagram"), actor: "operator" }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
  });
});
