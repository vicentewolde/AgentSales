import { describe, expect, it } from "vitest";
import { SAMPLE_CONTENT_DRAFT } from "../content/draft.js";
import { AppError } from "../errors.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { NewListing } from "../ports/listing-repository.js";
import type { Publication } from "../publication.js";
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
import { approveContent } from "./approve-content.js";
import { cancelPublication } from "./cancel-publication.js";
import { prepareContent } from "./prepare-content.js";
import { publishListing, startPublication } from "./publish-listing.js";
import { retirePublication } from "./retire-publication.js";

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

/**
 * Un aviso `ready` con 2 fotos y un video, preparado con el proveedor falso. Por defecto con la
 * cuenta de Instagram conectada y el texto aprobado (nacen carrusel y reel en `approved`).
 */
async function setup(
  options: { account?: boolean; approve?: boolean; queueFails?: () => AppError | undefined } = {},
) {
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
  const queue = createInMemoryJobQueue(
    options.queueFails === undefined ? {} : { fail: options.queueFails },
  );

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
  const connect = () =>
    platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: "instagram",
      externalAccountId: "17841400000000001",
      displayName: "@muestra",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "IGAA-prueba" },
    });
  const account = options.account === false ? null : await connect();
  const instagramId = async () =>
    (await contents.listCurrent(listing.id)).find((item) => item.platform === "instagram")?.id ??
    "";
  const approved =
    options.approve === false
      ? null
      : await approveContent(
          { contents, listings, fieldDefinitions, lock },
          { contentId: await instagramId(), actor: "operator" },
        );

  // Lo que se usa fuera del candado: falla si se llama dentro (`fn` solo usa lo del candado).
  let insideLock = false;
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
  const outsidePublications = {
    async get(id: string) {
      if (insideLock) throw new Error("get se llamó dentro del candado");
      return publications.get(id);
    },
  };
  // La cola se usa después del candado: falla si se encola dentro.
  const watchedQueue: typeof queue = {
    jobs: queue.jobs,
    async enqueue(name, data, enqueueOptions) {
      if (insideLock) throw new Error("se encoló dentro del candado");
      return queue.enqueue(name, data, enqueueOptions);
    },
  };
  const byFormat = (format: Publication["format"]) =>
    publications.all().find((publication) => publication.format === format);
  return {
    listingId: listing.id,
    locked,
    listings,
    contents,
    contentRuns,
    platformAccounts,
    publications,
    queue,
    account,
    connect,
    instagramId,
    approved,
    byFormat,
    deps: { lock: watchedLock, queue: watchedQueue, publications: outsidePublications },
    approveDeps: { contents, listings, fieldDefinitions, lock },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Lleva una publicación a `published` como lo haría el intento (T11). */
async function markPublished(t: Setup, id: string, dryRun: boolean) {
  await t.publications.transition(
    id,
    { from: "approved", to: "publishing", changes: { dryRun } },
    { actor: "system" },
  );
  return t.publications.transition(
    id,
    { from: "publishing", to: "published", changes: { externalId: `ig-${id}` } },
    { actor: "system" },
  );
}

const publish = (t: Setup, dryRun = true) =>
  publishListing(t.deps, {
    listingId: t.listingId,
    platform: "instagram",
    dryRun,
    actor: "operator",
  });

describe("publishListing", () => {
  it("pasa carrusel y reel a publishing con el modo de la API, su evento, y encola después de confirmar", async () => {
    const t = await setup();
    const result = await publish(t, false);

    expect(result.started.map((p) => [p.format, p.status, p.dryRun, p.attempts])).toEqual([
      ["post", "publishing", false, 1],
      ["reel", "publishing", false, 1],
    ]);
    expect(result.created).toEqual([]);
    expect(t.queue.jobs).toEqual(
      result.started.map((p) => ({
        name: "publication.publish",
        data: { publicationId: p.id },
        options: { singletonKey: p.id },
      })),
    );
    const events = await t.publications.listEvents(result.started[0]?.id ?? "");
    expect(events.at(-1)).toMatchObject({
      type: "status_changed",
      fromStatus: "approved",
      toStatus: "publishing",
      actor: "operator",
      payload: { mode: "live", attempt: 1 },
    });
    expect(result.publications.map((p) => p.status)).toEqual(["publishing", "publishing"]);
  });

  it("en dry-run fija dry_run y lo anota en la bitácora", async () => {
    const t = await setup();
    const result = await publish(t, true);
    expect(result.started.every((p) => p.dryRun)).toBe(true);
    const events = await t.publications.listEvents(result.started[0]?.id ?? "");
    expect(events.at(-1)?.payload).toEqual({ mode: "dry-run", attempt: 1 });
  });

  it("abre las que faltan si la cuenta se conectó después de aprobar", async () => {
    const t = await setup({ account: false });
    expect(t.approved?.created).toEqual([]);
    await t.connect();
    const result = await publish(t);
    expect(result.created.map((p) => p.format)).toEqual(["post", "reel"]);
    expect(result.started.map((p) => p.status)).toEqual(["publishing", "publishing"]);
    expect(t.queue.jobs).toHaveLength(2);
  });

  it("reintenta las fallidas conservando el progreso y borrando el error anterior", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    await t.publications.transition(
      post?.id ?? "",
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "system" },
    );
    const progress = {
      attemptStartedAt: "2026-10-05T12:00:00.000Z",
      childIds: [],
      containerId: "c-1",
    };
    await t.publications.saveProgress(post?.id ?? "", progress);
    await t.publications.transition(
      post?.id ?? "",
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "IG_UNAVAILABLE", message: "x", retriable: true } },
      },
      { actor: "system" },
    );
    await markPublished(t, reel?.id ?? "", true);

    const result = await publish(t);
    expect(result.started).toHaveLength(1);
    expect(result.started[0]).toMatchObject({
      id: post?.id,
      status: "publishing",
      attempts: 2,
      lastError: null,
      progress,
    });
  });

  it("sin nada que pasar a publishing (todo publicado o en curso) es NOTHING_TO_PUBLISH, sin encolar", async () => {
    const t = await setup();
    await markPublished(t, t.byFormat("post")?.id ?? "", true);
    await publish(t);
    await expect(publish(t)).rejects.toMatchObject({ code: "NOTHING_TO_PUBLISH" });
    expect(t.queue.jobs).toHaveLength(1);
  });

  it("sin texto aprobado es CONTENT_NOT_APPROVED", async () => {
    const t = await setup({ approve: false });
    await expect(publish(t)).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
    expect(t.publications.all()).toEqual([]);
  });

  it("sin cuenta conectada es ACCOUNT_NOT_CONNECTED; con las pendientes en una cuenta desconectada, también", async () => {
    const none = await setup({ account: false });
    await expect(publish(none)).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });

    const t = await setup();
    await t.platformAccounts.disconnect(t.account?.id ?? "");
    await expect(publish(t)).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    expect(t.publications.all().map((p) => p.status)).toEqual(["approved", "approved"]);
    expect(t.queue.jobs).toEqual([]);
  });

  it("un aviso que no está listo ni publicado es LISTING_NOT_READY; uno que no existe, LISTING_NOT_FOUND", async () => {
    const t = await setup();
    await t.listings.changeStatus(t.listingId, "ready", "paused");
    await expect(publish(t)).rejects.toMatchObject({ code: "LISTING_NOT_READY" });
    await expect(
      publishListing(t.deps, {
        listingId: "no-existe",
        platform: "instagram",
        dryRun: true,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
    expect(t.queue.jobs).toEqual([]);
  });

  it("un aviso active (ya publicado en otro formato) sí publica", async () => {
    const t = await setup();
    await t.listings.changeStatus(t.listingId, "ready", "active");
    await expect(publish(t)).resolves.toMatchObject({ started: [{}, {}] });
  });

  it("con una corrida activa es CONTENT_RUN_ACTIVE", async () => {
    const t = await setup();
    await t.contentRuns.create({ listingId: t.listingId, texts: false });
    await expect(publish(t)).rejects.toMatchObject({ code: "CONTENT_RUN_ACTIVE" });
  });

  it("si la cola no está, quedan en publishing (el worker las reencola) y se informa el error", async () => {
    const t = await setup({
      queueFails: () =>
        new AppError("QUEUE_UNAVAILABLE", "La cola no está disponible", { retriable: true }),
    });
    await expect(publish(t)).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    expect(t.publications.all().map((p) => p.status)).toEqual(["publishing", "publishing"]);
  });
});

describe("startPublication", () => {
  it("publica una aprobada y encola solo esa", async () => {
    const t = await setup();
    const reel = t.byFormat("reel");
    const result = await startPublication(t.deps, {
      publicationId: reel?.id ?? "",
      dryRun: false,
      actor: "cli",
    });
    expect(result).toMatchObject({
      requeued: false,
      publication: { id: reel?.id, status: "publishing", dryRun: false, attempts: 1 },
    });
    expect(t.queue.jobs.map((job) => job.data)).toEqual([{ publicationId: reel?.id }]);
    expect(t.byFormat("post")?.status).toBe("approved");
  });

  it("una en publishing se reencola sin cambiarla (conserva su modo)", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" });
    const again = await startPublication(t.deps, {
      publicationId: post?.id ?? "",
      dryRun: false,
      actor: "cli",
    });
    expect(again).toMatchObject({
      requeued: true,
      publication: { status: "publishing", dryRun: true, attempts: 1 },
    });
    expect(t.queue.jobs).toHaveLength(2);
  });

  it("rechazos: no existe, publicada, descartada, cuenta desconectada y aviso no listo", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    const start = (publicationId: string) =>
      startPublication(t.deps, { publicationId, dryRun: true, actor: "cli" });

    await expect(start("no-existe")).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
    await markPublished(t, post?.id ?? "", true);
    await expect(start(post?.id ?? "")).rejects.toMatchObject({ code: "NOTHING_TO_PUBLISH" });

    await t.platformAccounts.disconnect(t.account?.id ?? "");
    await expect(start(reel?.id ?? "")).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    await t.connect();
    await t.listings.changeStatus(t.listingId, "ready", "archived");
    await expect(start(reel?.id ?? "")).rejects.toMatchObject({ code: "LISTING_NOT_READY" });

    await cancelPublication(t.deps, { publicationId: reel?.id ?? "", actor: "cli" });
    await expect(start(reel?.id ?? "")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(t.queue.jobs).toEqual([]);
  });
});

describe("cancelPublication", () => {
  it("descarta una aprobada o fallida; el texto sigue aprobado y publicar abre otra", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const cancelled = await cancelPublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
    });
    expect(cancelled).toMatchObject({ id: post?.id, status: "cancelled" });
    const events = await t.publications.listEvents(post?.id ?? "");
    expect(events.at(-1)).toMatchObject({ fromStatus: "approved", toStatus: "cancelled" });
    const content = (await t.contents.listCurrent(t.listingId)).find(
      (item) => item.platform === "instagram",
    );
    expect(content?.status).toBe("approved");

    const result = await publish(t);
    expect(result.created.map((p) => p.format)).toEqual(["post"]);
  });

  it("una publicándose es PUBLICATION_IN_PROGRESS; una publicada, INVALID_TRANSITION (se retira)", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    await startPublication(t.deps, { publicationId: post?.id ?? "", dryRun: true, actor: "cli" });
    await expect(
      cancelPublication(t.deps, { publicationId: post?.id ?? "", actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_IN_PROGRESS" });
    await markPublished(t, reel?.id ?? "", true);
    await expect(
      cancelPublication(t.deps, { publicationId: reel?.id ?? "", actor: "cli" }),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      message: expect.stringContaining("retirada"),
    });
    await expect(
      cancelPublication(t.deps, { publicationId: "no-existe", actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
  });
});

describe("retirePublication", () => {
  it("en live exige la confirmación de que se borró a mano, sin cambiar nada", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, post?.id ?? "", false);
    await expect(
      retirePublication(t.deps, { publicationId: post?.id ?? "", actor: "operator" }),
    ).rejects.toMatchObject({ code: "REMOVAL_NOT_CONFIRMED" });
    expect(t.byFormat("post")?.status).toBe("published");
  });

  it("retirar la última publicada en live devuelve el aviso a ready; si queda otra, no", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    const reel = t.byFormat("reel");
    await markPublished(t, post?.id ?? "", false);
    await markPublished(t, reel?.id ?? "", false);
    await t.listings.changeStatus(t.listingId, "ready", "active");

    const first = await retirePublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
      removedByHand: true,
    });
    expect(first).toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: false,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");

    const last = await retirePublication(t.deps, {
      publicationId: reel?.id ?? "",
      actor: "operator",
      removedByHand: true,
    });
    expect(last.listingBackToReady).toBe(true);
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
    const events = await t.publications.listEvents(reel?.id ?? "");
    expect(events.at(-1)).toMatchObject({
      fromStatus: "published",
      toStatus: "unpublished",
      payload: { mode: "live", removedByHand: true },
    });
  });

  it("en dry-run se retira sin confirmación y no toca el aviso", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, post?.id ?? "", true);
    await t.listings.changeStatus(t.listingId, "ready", "active");
    const result = await retirePublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
    });
    expect(result).toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: false,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("si el aviso ya no está active (lo cambiaron), no se toca", async () => {
    const t = await setup();
    const post = t.byFormat("post");
    await markPublished(t, post?.id ?? "", false);
    await t.listings.changeStatus(t.listingId, "ready", "archived");
    const result = await retirePublication(t.deps, {
      publicationId: post?.id ?? "",
      actor: "operator",
      removedByHand: true,
    });
    expect(result.listingBackToReady).toBe(false);
    expect((await t.listings.get(t.listingId))?.status).toBe("archived");
  });

  it("una que no está publicada es INVALID_TRANSITION; una que no existe, PUBLICATION_NOT_FOUND", async () => {
    const t = await setup();
    await expect(
      retirePublication(t.deps, { publicationId: t.byFormat("post")?.id ?? "", actor: "cli" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      retirePublication(t.deps, { publicationId: "no-existe", actor: "cli" }),
    ).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
  });
});
