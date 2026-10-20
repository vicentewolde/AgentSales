import { describe, expect, it } from "vitest";
import type { Language, Platform, PostKind, PostStatus } from "../enums.js";
import { isAppError } from "../errors.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import { postSubject } from "../subject.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import { approveContent } from "./approve-content.js";
import { editContent } from "./edit-content.js";
import {
  createPostPublications,
  postPublicationMatchesSubject,
  postPublicationPlan,
} from "./open-publications.js";
import { type PrepareContentDeps, prepareContent } from "./prepare-content.js";
import { requestContentRun } from "./request-content-run.js";
import { unapproveContent } from "./unapprove-content.js";

// Aprobar, quitar la aprobación, editar y pedir los textos de un post (F9-T05, ADR-0029): los
// mismos casos de uso que un aviso, en el candado del post.

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);

type Setup = {
  kind?: PostKind;
  status?: PostStatus;
  /** Los textos que deja la corrida: un texto por red e idioma. */
  texts?: { platform: Platform; language: Language }[];
  /** Las redes con una cuenta conectada de la marca. */
  accounts?: Platform[];
};

async function setup(options: Setup = {}) {
  const broker = contentBrokerFixture({ kind: "brand" });
  const brokers = createInMemoryBrokerRepository([broker]);
  const posts = createInMemoryPostRepository();
  const post = await posts.create({
    brokerId: broker.id,
    topic: "Lo que aprendí construyendo",
    kind: options.kind ?? "image",
    status: options.status ?? "draft",
  });
  const media = createInMemoryMediaRepository();
  const original = await media.create({
    listingId: null,
    postId: post.id,
    brokerId: broker.id,
    kind: "image",
    storagePath: `posts/${post.id}/original/foto.jpg`,
    mime: "image/jpeg",
    bytes: 10,
    checksum: "sha-foto",
    sortOrder: 0,
    isCover: false,
  });
  const { media: image } = await media.upsertDerivative({
    role: "processed",
    variant: "ig_4x5",
    parentMediaId: original.id,
    postId: post.id,
    brokerId: broker.id,
    kind: "image",
    storagePath: `posts/${post.id}/ig_4x5/foto.jpg`,
    mime: "image/jpeg",
    bytes: 8,
    checksum: "sha-foto-4x5",
    width: 1080,
    height: 1350,
    durationS: null,
  });
  const { contents, contentRuns } = createInMemoryContentRepositories();
  const publications = createInMemoryPublicationRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const listings = createInMemoryListingRepository();
  const repos: PostLockedRepositories = {
    brokers,
    posts,
    postUploads: createInMemoryPostUploadRepository(),
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  };
  const postLock = createInMemoryPostLock(repos);
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  });
  const run = await contentRuns.create({ postId: post.id, texts: true });
  await contentRuns.markRunning(run.id);
  await contentRuns.markSucceeded(run.id, {
    report: { warnings: [] },
    contents: (options.texts ?? [{ platform: "linkedin", language: "es" }]).map((text) => ({
      platform: text.platform,
      language: text.language,
      title: null,
      body: `Texto en ${text.language} para ${text.platform}`,
      hashtags: ["#agentpey"],
      llmProvider: "fake",
      llmModel: "fake",
      promptVersion: "social-v1",
      rawOutput: null,
    })),
  });
  const accounts = new Map<Platform, string>();
  for (const platform of options.accounts ?? ["linkedin"]) {
    const account = await platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform,
      externalAccountId: `cuenta-${platform}`,
      displayName: `@agentpey-${platform}`,
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "token-prueba" },
    });
    accounts.set(platform, account.id);
  }
  const deps = {
    contents,
    listings,
    fieldDefinitions: createInMemoryFieldDefinitionRepository([]),
    lock,
    postLock,
  };
  const contentId = async (platform: Platform, language: Language = "es") => {
    const found = (await contents.listCurrent(postSubject(post.id))).find(
      (item) => item.platform === platform && item.language === language,
    );
    if (found === undefined) throw new Error(`sin texto ${platform}/${language}`);
    return found.id;
  };
  const postStatus = async () => (await posts.get(post.id))?.status;
  return { deps, repos, post, image, accounts, lock, postLock, contentId, postStatus };
}

describe("approveContent con un post", () => {
  it("aprueba, abre una publicación por cuenta con su idioma y sin versión del aviso, y deja el post listo", async () => {
    const t = await setup();
    const contentId = await t.contentId("linkedin");

    const result = await approveContent(t.deps, { contentId, actor: "operator" });

    expect(result.content).toMatchObject({ id: contentId, status: "approved" });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      subject: { kind: "post", id: t.post.id },
      listingId: null,
      platform: "linkedin",
      platformAccountId: t.accounts.get("linkedin"),
      format: "post",
      language: "es",
      contentId,
      mediaIds: [t.image.id],
      listingSourceHash: null,
      status: "approved",
    });
    expect(result.publications.map((p) => p.id)).toEqual(result.created.map((p) => p.id));
    expect(result.portalReadiness).toBeUndefined();
    expect(result.marketplaceReadiness).toBeUndefined();
    expect(await t.postStatus()).toBe("ready");
    // Corre en el candado del post y lo suelta.
    expect(t.postLock.busy()).toEqual([]);
    expect(t.lock.busy()).toEqual([]);
  });

  it("cada idioma abre su propia publicación en la misma cuenta y formato", async () => {
    const t = await setup({
      texts: [
        { platform: "linkedin", language: "es" },
        { platform: "linkedin", language: "en" },
      ],
    });

    const es = await approveContent(t.deps, {
      contentId: await t.contentId("linkedin", "es"),
      actor: "operator",
    });
    const en = await approveContent(t.deps, {
      contentId: await t.contentId("linkedin", "en"),
      actor: "operator",
    });

    expect(es.created.map((p) => p.language)).toEqual(["es"]);
    expect(en.created.map((p) => p.language)).toEqual(["en"]);
    expect(en.skipped).toEqual([]);
    expect(en.publications.map((p) => p.language).sort()).toEqual(["en", "es"]);
    // Aprobar de nuevo no abre otra (idempotente por cuenta, formato e idioma).
    const again = await approveContent(t.deps, {
      contentId: await t.contentId("linkedin", "en"),
      actor: "operator",
    });
    expect(again.created).toEqual([]);
  });

  it("sin cuenta conectada aprueba sin abrir publicaciones", async () => {
    const t = await setup({ accounts: [] });
    const result = await approveContent(t.deps, {
      contentId: await t.contentId("linkedin"),
      actor: "operator",
    });
    expect(result.created).toEqual([]);
    expect(await t.postStatus()).toBe("ready");
  });

  it("una idea o un post archivado no se aprueban (POST_NOT_READY)", async () => {
    for (const status of ["idea", "archived"] as const) {
      const t = await setup({ status });
      const error = await caught(
        approveContent(t.deps, { contentId: await t.contentId("linkedin"), actor: "operator" }),
      );
      expect(codeOf(error)).toBe("POST_NOT_READY");
      expect(await t.repos.publications.listBySubject(postSubject(t.post.id))).toEqual([]);
    }
  });

  it("con una corrida activa del post es CONTENT_RUN_ACTIVE, sin escribir", async () => {
    const t = await setup();
    const contentId = await t.contentId("linkedin");
    await t.repos.contentRuns.create({ postId: t.post.id, texts: true });

    expect(codeOf(await caught(approveContent(t.deps, { contentId, actor: "operator" })))).toBe(
      "CONTENT_RUN_ACTIVE",
    );
    expect((await t.repos.contents.get(contentId))?.status).toBe("draft");
    expect(await t.postStatus()).toBe("draft");
  });

  it("Instagram sin medios en un post de solo texto es CONTENT_NOT_READY", async () => {
    const t = await setup({
      kind: "text",
      texts: [{ platform: "instagram", language: "es" }],
      accounts: ["instagram"],
    });
    const error = await caught(
      approveContent(t.deps, { contentId: await t.contentId("instagram"), actor: "operator" }),
    );
    expect(codeOf(error)).toBe("CONTENT_NOT_READY");
    expect(await t.postStatus()).toBe("draft");
  });

  it("sin el candado de posts (auto_publish, solo avisos), un post es SUBJECT_NOT_LISTING", async () => {
    const t = await setup();
    const { postLock: _postLock, ...listingOnly } = t.deps;
    const error = await caught(
      approveContent(listingOnly, { contentId: await t.contentId("linkedin"), actor: "system" }),
    );
    expect(codeOf(error)).toBe("SUBJECT_NOT_LISTING");
  });
});

describe("unapproveContent con un post", () => {
  it("cancela las publicaciones de ese texto y el post vuelve a borrador", async () => {
    const t = await setup();
    const contentId = await t.contentId("linkedin");
    const approved = await approveContent(t.deps, { contentId, actor: "operator" });

    const result = await unapproveContent(t.deps, { contentId, actor: "operator" });

    expect(result.content.status).toBe("edited");
    expect(result.cancelled.map((p) => [p.id, p.status])).toEqual(
      approved.created.map((p) => [p.id, "cancelled"]),
    );
    expect(result.publications.map((p) => p.status)).toEqual(["cancelled"]);
    expect(await t.postStatus()).toBe("draft");
  });

  it("con otro texto aprobado, el post sigue listo", async () => {
    const t = await setup({
      texts: [
        { platform: "linkedin", language: "es" },
        { platform: "linkedin", language: "en" },
      ],
    });
    const es = await t.contentId("linkedin", "es");
    await approveContent(t.deps, { contentId: es, actor: "operator" });
    await approveContent(t.deps, {
      contentId: await t.contentId("linkedin", "en"),
      actor: "operator",
    });

    const result = await unapproveContent(t.deps, { contentId: es, actor: "operator" });

    expect(result.cancelled.map((p) => p.language)).toEqual(["es"]);
    expect(await t.postStatus()).toBe("ready");
  });
});

describe("editContent con un post", () => {
  it("con la corrida de textos activa es CONTENT_RUN_ACTIVE y no cambia nada", async () => {
    const t = await setup();
    const contentId = await t.contentId("linkedin");
    await t.repos.contentRuns.create({ postId: t.post.id, texts: true });

    const error = await caught(editContent(t.deps, { contentId, edit: { body: "otro" } }));

    expect(codeOf(error)).toBe("CONTENT_RUN_ACTIVE");
    expect((await t.repos.contents.get(contentId))?.body).toBe("Texto en es para linkedin");
  });

  it("edita el cuerpo y los hashtags en cualquier red; un título no", async () => {
    const t = await setup();
    const contentId = await t.contentId("linkedin");

    const result = await editContent(t.deps, {
      contentId,
      edit: { body: "Nuevo texto", hashtags: ["#Producto", "#producto", ""] },
    });

    expect(result.content).toMatchObject({ status: "edited", body: "Nuevo texto" });
    expect(result.content.hashtags).toEqual(["#producto"]);
    expect(
      codeOf(await caught(editContent(t.deps, { contentId, edit: { title: "Título" } }))),
    ).toBe("CONTENT_TITLE_INVALID");
  });

  it("editar el único texto aprobado (sin publicaciones activas) lo saca de aprobado y el post vuelve a borrador", async () => {
    const t = await setup({ accounts: [] });
    const contentId = await t.contentId("linkedin");
    await approveContent(t.deps, { contentId, actor: "operator" });
    expect(await t.postStatus()).toBe("ready");

    await editContent(t.deps, { contentId, edit: { body: "Cambio" } });

    expect((await t.repos.contents.get(contentId))?.status).toBe("edited");
    expect(await t.postStatus()).toBe("draft");
  });

  it("con una publicación aprobada es CONTENT_LOCKED", async () => {
    const t = await setup();
    const contentId = await t.contentId("linkedin");
    await approveContent(t.deps, { contentId, actor: "operator" });
    expect(codeOf(await caught(editContent(t.deps, { contentId, edit: { body: "x" } })))).toBe(
      "CONTENT_LOCKED",
    );
  });
});

describe("requestContentRun con un post", () => {
  async function runSetup(options: Setup = {}) {
    const t = await setup(options);
    const queue = createInMemoryJobQueue();
    const deps = {
      lock: t.lock,
      postLock: t.postLock,
      contentRuns: t.repos.contentRuns,
      queue,
    };
    return { ...t, queue, runDeps: deps };
  }

  it("crea la corrida del post y encola post.draft, nunca content.prepare", async () => {
    const t = await runSetup({ texts: [] });

    const { run, reused } = await requestContentRun(t.runDeps, { postId: t.post.id });

    expect(reused).toBe(false);
    expect(run).toMatchObject({ subject: { kind: "post", id: t.post.id }, texts: true });
    expect(t.queue.jobs.map((job) => [job.name, job.data])).toEqual([
      ["post.draft", { contentRunId: run.id }],
    ]);
    expect(t.queue.jobs[0]?.options).toEqual({ singletonKey: run.id });
    // Otra vez: devuelve la activa y la vuelve a encolar como post.draft.
    const again = await requestContentRun(t.runDeps, { postId: t.post.id });
    expect([again.reused, again.run.id]).toEqual([true, run.id]);
    expect(t.queue.jobs.map((job) => job.name)).toEqual(["post.draft", "post.draft"]);
  });

  it("un post sin medios también pide sus textos", async () => {
    const t = await runSetup({ kind: "text", texts: [] });
    const { run } = await requestContentRun(t.runDeps, { postId: t.post.id });
    expect(run.subject).toEqual({ kind: "post", id: t.post.id });
  });

  it("una idea sin aceptar es POST_NOT_READY y no encola", async () => {
    const t = await runSetup({ status: "idea", texts: [] });
    const error = await caught(requestContentRun(t.runDeps, { postId: t.post.id }));
    expect(codeOf(error)).toBe("POST_NOT_READY");
    expect(t.queue.jobs).toEqual([]);
  });

  it("solo textos: texts=false es CONTENT_RUN_INVALID", async () => {
    const t = await runSetup({ texts: [] });
    const error = await caught(requestContentRun(t.runDeps, { postId: t.post.id, texts: false }));
    expect(codeOf(error)).toBe("CONTENT_RUN_INVALID");
  });

  it("con textos editados o aprobados es CONTENT_EDITED salvo replaceEdits", async () => {
    const t = await runSetup({ accounts: [] });
    await approveContent(t.deps, { contentId: await t.contentId("linkedin"), actor: "operator" });

    expect(codeOf(await caught(requestContentRun(t.runDeps, { postId: t.post.id })))).toBe(
      "CONTENT_EDITED",
    );
    const { run } = await requestContentRun(t.runDeps, { postId: t.post.id, replaceEdits: true });
    expect(run.subject.kind).toBe("post");
  });

  it("con publicaciones pendientes es PUBLICATION_PENDING", async () => {
    const t = await runSetup();
    await approveContent(t.deps, { contentId: await t.contentId("linkedin"), actor: "operator" });
    const error = await caught(
      requestContentRun(t.runDeps, { postId: t.post.id, replaceEdits: true }),
    );
    expect(codeOf(error)).toBe("PUBLICATION_PENDING");
  });
});

describe("prepareContent con una corrida de post", () => {
  it("no la toma: SUBJECT_NOT_LISTING no reintentable y la corrida sigue en cola para post.draft", async () => {
    const t = await setup({ texts: [] });
    const run = await t.repos.contentRuns.create({ postId: t.post.id, texts: true });
    // Antes de la guarda solo se usa `contentRuns`: el resto no debe llamarse.
    const deps = { contentRuns: t.repos.contentRuns } as unknown as PrepareContentDeps;

    const error = await caught(prepareContent(deps, { contentRunId: run.id, isLastAttempt: true }));

    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "SUBJECT_NOT_LISTING",
      false,
    ]);
    expect(await t.repos.contentRuns.get(run.id)).toMatchObject({ status: "queued", stage: null });
  });
});

describe("postPublicationPlan", () => {
  it("un texto solo va sin medios fuera de Instagram y TikTok", async () => {
    expect(postPublicationPlan("linkedin", "text", [])).toEqual({ format: "post", mediaIds: [] });
    expect(postPublicationPlan("x", "text", [])).toEqual({ format: "post", mediaIds: [] });
    expect(
      codeOf(
        await caught(Promise.resolve().then(() => postPublicationPlan("instagram", "text", []))),
      ),
    ).toBe("CONTENT_NOT_READY");
  });

  it("Portal y Marketplace no publican posts", async () => {
    for (const platform of ["portal_inmobiliario", "fb_marketplace"] as const) {
      const error = await caught(
        Promise.resolve().then(() => postPublicationPlan(platform, "text", [])),
      );
      expect(codeOf(error)).toBe("CONTENT_PLATFORM_INVALID");
    }
  });

  it("una imagen usa su ig_4x5; sin procesar es CONTENT_NOT_READY", async () => {
    const t = await setup();
    const media = await t.repos.media.listBySubject(postSubject(t.post.id));
    expect(postPublicationPlan("instagram", "image", media)).toEqual({
      format: "post",
      mediaIds: [t.image.id],
    });
    const originals = media.filter((item) => item.role === "original");
    const error = await caught(
      Promise.resolve().then(() => postPublicationPlan("x", "image", originals)),
    );
    expect(codeOf(error)).toBe("CONTENT_NOT_READY");
  });
});

describe("postPublicationMatchesSubject", () => {
  const subject = postSubject("post-1");
  const content = { subject, language: "es" as const };
  const ownMedia = [{ id: "m1", postId: "post-1" }];

  it("calza si el texto es del post y su idioma, y los medios son del post", () => {
    expect(
      postPublicationMatchesSubject(
        subject,
        { language: "es", mediaIds: ["m1"] },
        content,
        ownMedia,
      ),
    ).toBe(true);
    expect(
      postPublicationMatchesSubject(subject, { language: "es", mediaIds: [] }, content, []),
    ).toBe(true);
  });

  it("createPostPublications no escribe una que no calza (PUBLICATION_SUBJECT_MISMATCH)", async () => {
    const t = await setup();
    const content = await t.repos.contents.get(await t.contentId("linkedin"));
    if (content === null) throw new Error("sin texto");
    const planned = {
      format: "post" as const,
      platformAccountId: t.accounts.get("linkedin") ?? "",
      language: "es" as const,
    };
    for (const item of [
      { ...planned, mediaIds: ["medio-de-otro-post"] },
      { ...planned, mediaIds: [t.image.id], language: "en" as const },
    ]) {
      const error = await caught(
        createPostPublications(t.repos, {
          post: t.post,
          content,
          planned: [item],
          actor: "operator",
        }),
      );
      expect(codeOf(error)).toBe("PUBLICATION_SUBJECT_MISMATCH");
    }
    expect(await t.repos.publications.listBySubject(postSubject(t.post.id))).toEqual([]);
  });

  it("no calza con otro idioma, el texto de otro sujeto o un medio ajeno", () => {
    const publication = { language: "es" as const, mediaIds: ["m1"] };
    expect(
      postPublicationMatchesSubject(subject, { ...publication, language: "en" }, content, ownMedia),
    ).toBe(false);
    expect(
      postPublicationMatchesSubject(
        subject,
        publication,
        { subject: postSubject("post-2"), language: "es" },
        ownMedia,
      ),
    ).toBe(false);
    expect(
      postPublicationMatchesSubject(
        subject,
        publication,
        { subject: { kind: "listing", id: "post-1" }, language: "es" },
        ownMedia,
      ),
    ).toBe(false);
    expect(
      postPublicationMatchesSubject(subject, publication, content, [
        { id: "m1", postId: "post-2" },
      ]),
    ).toBe(false);
    expect(postPublicationMatchesSubject(subject, publication, content, [])).toBe(false);
  });
});
