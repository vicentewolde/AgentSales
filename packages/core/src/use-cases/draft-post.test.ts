import { describe, expect, it } from "vitest";
import { ALL_SCOPE } from "../access.js";
import { editorialProfileView } from "../editorial-profile.js";
import type { Language, Platform, PostKind, PostPlatform, PostStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { monthlySpend } from "../llm-budget.js";
import type { LlmTokenUsage } from "../llm-usage.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import { SOCIAL_PROMPT_VERSION } from "../social/prompt.js";
import { postSubject } from "../subject.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "../testing/index.js";
import { approveContent } from "./approve-content.js";
import { type DraftPostDeps, draftPost } from "./draft-post.js";
import { requestContentRun } from "./request-content-run.js";

// La corrida de textos de un post (job `post.draft`, F9-T11): con proveedores guionados, nunca la
// IA real.

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);

const SPEND: LlmTokenUsage = {
  inputTokens: 2000,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 1000,
  requestId: "req_1",
};

/** La respuesta de la IA: un texto por red e idioma (`body` por defecto, limpio). */
const answer = (
  pairs: { platform: Platform; language: Language; body?: string }[],
  warnings: string[] = [],
) => ({
  texts: pairs.map(({ platform, language, body }) => ({
    platform,
    language,
    body:
      body ??
      (language === "es"
        ? "Hoy les cuento cómo AgentPey publica en LinkedIn."
        : "Today I share how AgentPey works."),
    hashtags: ["#AgentPey"],
  })),
  warnings,
});

type Setup = {
  languages?: Language[];
  accounts?: Platform[];
  kind?: PostKind;
  status?: PostStatus;
  briefOrigin?: "operator" | "ai";
  /** Respuestas del proveedor del operador (marca propia). */
  llm?: ScriptedLlmResponse[];
  /** Respuestas de la API (marca de un tercero: `operatorOwned = false`). */
  apiLlm?: ScriptedLlmResponse[];
  capUsd?: number | null;
  /** Las redes del post (F9-T20); por defecto `null`, todas las de la marca. */
  platforms?: PostPlatform[] | null;
};

async function setup(options: Setup = {}) {
  const usesApi = options.apiLlm !== undefined;
  const broker = contentBrokerFixture({
    kind: "brand",
    brandName: "AgentPey",
    slug: "agentpey",
    operatorOwned: !usesApi,
    llmMonthlyCapUsd: options.capUsd ?? null,
  });
  const brokers = createInMemoryBrokerRepository([broker]);
  const posts = createInMemoryPostRepository();
  const post = await posts.create({
    brokerId: broker.id,
    topic: "Cómo publicamos",
    kind: options.kind ?? "text",
    status: options.status ?? "draft",
    brief: "Contar que ya sumamos 3 redes",
    briefOrigin: options.briefOrigin ?? "operator",
    platforms: options.platforms ?? null,
  });
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  await editorialProfiles.upsert(broker.id, {
    ...editorialProfileView(broker.id, null),
    languages: options.languages ?? ["es"],
    facts: ["AgentPey publica en LinkedIn y X"],
  });
  const media = createInMemoryMediaRepository();
  const platformAccounts = createInMemoryPlatformAccountRepository();
  for (const platform of options.accounts ?? ["linkedin", "x"]) {
    await platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform,
      externalAccountId: `cuenta-${platform}`,
      displayName: `@agentpey-${platform}`,
      tokenExpiresAt: null,
      meta: {},
      credentials:
        platform === "x"
          ? { accessToken: "token-prueba", refreshToken: "refresh-prueba" }
          : { accessToken: "token-prueba" },
    });
  }
  const { contents, contentRuns } = createInMemoryContentRepositories({
    brokerOfPost: async (postId) => (await posts.get(postId))?.brokerId ?? null,
  });
  const publications = createInMemoryPublicationRepository();
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
  const listings = createInMemoryListingRepository();
  const lock = createInMemoryListingLock({
    brokers,
    listings,
    media,
    contentRuns,
    contents,
    publications,
    platformAccounts,
  });
  const llm = createInMemoryLlmProvider(options.llm ?? [], "claude-cli");
  const apiLlm = usesApi ? createInMemoryLlmProvider(options.apiLlm ?? [], "anthropic-api") : null;
  const deps: DraftPostDeps = {
    contentRuns,
    posts,
    brokers,
    editorialProfiles,
    platformAccounts,
    media,
    postLock,
    llm,
    apiLlm,
    clock: () => new Date("2026-10-20T15:00:00Z"),
  };
  const queue = createInMemoryJobQueue();
  const request = (replaceEdits = false) =>
    requestContentRun(
      { lock, postLock, contentRuns, queue, now: () => new Date("2026-10-20T15:00:00Z") },
      { postId: post.id, replaceEdits },
    );
  const current = () => contents.listCurrent(postSubject(post.id));
  const approveDeps = {
    contents,
    listings,
    fieldDefinitions: createInMemoryFieldDefinitionRepository([]),
    postReview: { posts, editorialProfiles },
    lock,
    postLock,
  };
  return {
    broker,
    post,
    deps,
    llm,
    apiLlm,
    queue,
    contentRuns,
    posts,
    request,
    current,
    approveDeps,
    postLock,
    editorialProfiles,
  };
}

describe("draftPost", () => {
  it("redacta un texto por red y lo guarda en draft con la versión del prompt social", async () => {
    const t = await setup({
      llm: [
        {
          data: answer(
            [
              { platform: "linkedin", language: "es" },
              { platform: "x", language: "es" },
            ],
            ["Faltó un dato para cerrar mejor"],
          ),
          model: "claude-sonnet-5-5",
        },
      ],
    });
    const { run } = await t.request();
    expect(t.queue.jobs).toEqual([
      { name: "post.draft", data: { contentRunId: run.id }, options: { singletonKey: run.id } },
    ]);

    const result = await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });

    expect(result).toMatchObject({ outcome: "succeeded", postStatus: "draft" });
    const texts = await t.current();
    expect(texts.map((item) => [item.platform, item.language, item.status])).toEqual([
      ["x", "es", "draft"],
      ["linkedin", "es", "draft"],
    ]);
    expect(texts[0]).toMatchObject({
      title: null,
      hashtags: ["#AgentPey"],
      llmProvider: "claude-cli",
      llmModel: "claude-sonnet-5-5",
      promptVersion: SOCIAL_PROMPT_VERSION,
    });
    const saved = await t.contentRuns.get(run.id);
    expect(saved?.status).toBe("succeeded");
    expect(saved?.stage).toBe("texts");
    expect(saved?.report).toMatchObject({
      llm: { provider: "claude-cli", promptVersion: SOCIAL_PROMPT_VERSION, attempts: 1 },
      warnings: ["Faltó un dato para cerrar mejor"],
      postChecks: [
        { platform: "x", language: "es", codes: [] },
        { platform: "linkedin", language: "es", codes: [] },
      ],
    });
    // La IA recibió el perfil de la marca y el brief del operador, y nada más.
    const [request] = t.llm.requests;
    expect(request?.prompt).toContain("AgentPey publica en LinkedIn y X");
    expect(request?.prompt).toContain("Contar que ya sumamos 3 redes");
    expect(t.postLock.busy()).toEqual([]);
  });

  it("con dos idiomas redacta un texto por red e idioma", async () => {
    const pairs = [
      { platform: "linkedin" as const, language: "es" as const },
      { platform: "linkedin" as const, language: "en" as const },
    ];
    const t = await setup({
      languages: ["es", "en"],
      accounts: ["linkedin"],
      llm: [{ data: answer(pairs) }],
    });
    const { run } = await t.request();

    await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });

    expect((await t.current()).map((item) => `${item.platform}:${item.language}`)).toEqual([
      "linkedin:es",
      "linkedin:en",
    ]);
    expect(t.llm.requests[0]?.prompt).toContain('"language": "en"');
  });

  it("un texto que falta se reintenta una vez con el motivo, y la revisión queda en el reporte", async () => {
    const t = await setup({
      accounts: ["linkedin", "x"],
      llm: [
        { data: answer([{ platform: "linkedin", language: "es" }]) },
        {
          data: answer([
            {
              platform: "linkedin",
              language: "es",
              body: "Hoy les cuento que ya somos 500 clientes.",
            },
            { platform: "x", language: "es", body: "Atención @everyone, novedades." },
          ]),
        },
      ],
    });
    const { run } = await t.request();

    await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });

    expect(t.llm.requests[1]?.prompt).toContain("texts: falta el texto de x en es");
    const report = (await t.contentRuns.get(run.id))?.report;
    expect(report?.llm?.attempts).toBe(2);
    expect(report?.postChecks).toEqual([
      { platform: "x", language: "es", codes: ["MASS_MENTION"] },
      { platform: "linkedin", language: "es", codes: ["FACT_NOT_IN_PROFILE"] },
    ]);
  });

  it("un @everyone o una cifra ajena al perfil impiden aprobar el texto redactado", async () => {
    const t = await setup({
      accounts: ["linkedin", "x"],
      llm: [
        {
          data: answer([
            { platform: "x", language: "es", body: "Atención @everyone, novedades." },
            {
              platform: "linkedin",
              language: "es",
              body: "Hoy les cuento que ya somos 500 clientes.",
            },
          ]),
        },
      ],
    });
    const { run } = await t.request();
    await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });

    for (const content of await t.current()) {
      const error = await caught(
        approveContent(t.approveDeps, { contentId: content.id, actor: "operator" }),
      );
      expect(codeOf(error)).toBe("CONTENT_HAS_ERRORS");
    }
  });

  it("un brief de la IA no vale como fuente: su cifra impide aprobar", async () => {
    const body = "Hoy les cuento que ya sumamos 3 redes.";
    const run = async (briefOrigin: "operator" | "ai") => {
      const t = await setup({
        briefOrigin,
        accounts: ["linkedin"],
        llm: [{ data: answer([{ platform: "linkedin", language: "es", body }]) }],
      });
      const { run: created } = await t.request();
      await draftPost(t.deps, { contentRunId: created.id, isLastAttempt: false });
      const [content] = await t.current();
      if (content === undefined) throw new Error("sin texto");
      return {
        prompt: t.llm.requests[0]?.prompt ?? "",
        approve: await caught(
          approveContent(t.approveDeps, { contentId: content.id, actor: "operator" }),
        ),
      };
    };
    const fromOperator = await run("operator");
    expect(fromOperator.approve).toBeNull();
    const fromAi = await run("ai");
    expect(fromAi.prompt).not.toContain("Contar que ya sumamos 3 redes");
    expect(codeOf(fromAi.approve)).toBe("CONTENT_HAS_ERRORS");
    expect(isAppError(fromAi.approve) && fromAi.approve.details?.codes).toEqual([
      "FACT_NOT_IN_PROFILE",
    ]);
  });

  it("anota el gasto en la corrida y suma por marca (la API, para una marca de un tercero)", async () => {
    const t = await setup({
      accounts: ["linkedin"],
      apiLlm: [
        {
          data: answer([{ platform: "linkedin", language: "es" }]),
          model: "claude-sonnet-5-5",
          usage: SPEND,
        },
      ],
    });
    const { run } = await t.request();

    await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });

    expect(t.llm.requests).toHaveLength(0);
    const saved = await t.contentRuns.get(run.id);
    expect(saved?.llmUsage).toMatchObject({ calls: 1, provider: "anthropic-api", costUsd: 0.014 });
    const [spend] = await monthlySpend(
      {
        contentRuns: t.contentRuns,
        brokers: createInMemoryBrokerRepository([t.broker]),
      },
      { month: "2026-10", scope: ALL_SCOPE },
    );
    expect(spend).toMatchObject({ brokerId: t.broker.id, spentUsd: 0.014, runs: 1 });
  });

  it("con el tope del mes alcanzado no llama a la IA y la corrida falla con LLM_BUDGET_EXCEEDED", async () => {
    const t = await setup({
      accounts: ["linkedin"],
      capUsd: 0.01,
      apiLlm: [
        {
          data: answer([{ platform: "linkedin", language: "es" }]),
          model: "claude-sonnet-5-5",
          usage: SPEND,
        },
      ],
    });
    // Una primera corrida gasta US$0,014, más que el tope de US$0,01.
    const first = await t.request();
    await draftPost(t.deps, { contentRunId: first.run.id, isLastAttempt: false });
    // Una segunda corrida que ya estaba en cola (se crea directo): el worker revisa el tope otra
    // vez antes de llamar.
    const second = await t.contentRuns.create({ postId: t.post.id, texts: true });

    const error = await caught(
      draftPost(t.deps, { contentRunId: second.id, isLastAttempt: false }),
    );

    expect(codeOf(error)).toBe("LLM_BUDGET_EXCEEDED");
    expect(t.apiLlm?.requests).toHaveLength(1);
    expect(await t.contentRuns.get(second.id)).toMatchObject({
      status: "failed",
      error: { code: "LLM_BUDGET_EXCEEDED" },
    });
    // Y pedirla de nuevo ya lo frena antes de crear la corrida.
    expect(codeOf(await caught(t.request(true)))).toBe("LLM_BUDGET_EXCEEDED");
  });

  it("un error reintentable deja la corrida en running para el reintento, que termina bien", async () => {
    const t = await setup({
      accounts: ["linkedin"],
      llm: [
        { error: LLM_ERRORS.unavailable() },
        { data: answer([{ platform: "linkedin", language: "es" }]) },
      ],
    });
    const { run } = await t.request();

    const error = await caught(draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false }));
    expect(codeOf(error)).toBe("LLM_UNAVAILABLE");
    expect((await t.contentRuns.get(run.id))?.status).toBe("running");

    const retry = await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });
    expect(retry.outcome).toBe("succeeded");
    expect(await t.current()).toHaveLength(1);
  });

  it("en el último intento, un error reintentable deja la corrida en failed", async () => {
    const t = await setup({ accounts: ["linkedin"], llm: [{ error: LLM_ERRORS.unavailable() }] });
    const { run } = await t.request();

    await caught(draftPost(t.deps, { contentRunId: run.id, isLastAttempt: true }));

    expect(await t.contentRuns.get(run.id)).toMatchObject({
      status: "failed",
      error: { code: "LLM_UNAVAILABLE" },
    });
  });

  it("al apagar el worker relanza como reintentable sin cerrar la corrida", async () => {
    const t = await setup({ accounts: ["linkedin"], llm: [] });
    const { run } = await t.request();
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };

    const error = await caught(
      draftPost(t.deps, { contentRunId: run.id, isLastAttempt: true, signal }),
    );

    expect(isAppError(error) && error.retriable).toBe(true);
    expect((await t.contentRuns.get(run.id))?.status).toBe("running");
  });

  it("sin redes (ni cuentas ni cadencia) falla con POST_NO_PLATFORMS sin llamar a la IA", async () => {
    const t = await setup({ accounts: [], llm: [] });
    const { run } = await t.request();

    const error = await caught(draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false }));

    expect(codeOf(error)).toBe("POST_NO_PLATFORMS");
    expect((await t.contentRuns.get(run.id))?.status).toBe("failed");
  });

  it("un post archivado entre el pedido y el job falla con POST_NOT_READY", async () => {
    const t = await setup({ accounts: ["linkedin"], llm: [] });
    const { run } = await t.request();
    await t.posts.update(t.post.id, { status: "archived" });

    const error = await caught(draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false }));

    expect(codeOf(error)).toBe("POST_NOT_READY");
    expect((await t.contentRuns.get(run.id))?.error?.code).toBe("POST_NOT_READY");
  });

  it("una corrida terminada no se toca, y una de aviso es SUBJECT_NOT_POST sin tocarla", async () => {
    const t = await setup({ accounts: ["linkedin"], llm: [] });
    const { run } = await t.request();
    await t.contentRuns.markFailed(run.id, { code: "X", message: "x" });
    expect(await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false })).toEqual({
      outcome: "skipped",
      status: "failed",
    });

    const listingRun = await t.contentRuns.create({ listingId: "aviso-1", texts: true });
    const error = await caught(
      draftPost(t.deps, { contentRunId: listingRun.id, isLastAttempt: true }),
    );
    expect(codeOf(error)).toBe("SUBJECT_NOT_POST");
    expect((await t.contentRuns.get(listingRun.id))?.status).toBe("queued");
  });
});

describe("draftPost con replaceEdits (settlePostStatus)", () => {
  const linkedin = [{ platform: "linkedin" as const, language: "es" as const }];

  it("con la publicación de lo aprobado pendiente, pedir de nuevo es PUBLICATION_PENDING", async () => {
    const t = await setup({
      accounts: ["linkedin"],
      llm: [{ data: answer(linkedin) }, { data: answer(linkedin) }],
    });
    const first = await t.request();
    await draftPost(t.deps, { contentRunId: first.run.id, isLastAttempt: false });
    const [content] = await t.current();
    if (content === undefined) throw new Error("sin texto");
    await approveContent(t.approveDeps, { contentId: content.id, actor: "operator" });
    expect((await t.posts.get(t.post.id))?.status).toBe("ready");

    expect(codeOf(await caught(t.request()))).toBe("PUBLICATION_PENDING");
  });

  it("sin publicaciones pendientes, reemplazar el texto aprobado deja el post en draft", async () => {
    // Sin cuenta conectada aprobar no abre publicaciones; LinkedIn entra por la cadencia.
    const t = await setup({
      accounts: [],
      llm: [{ data: answer(linkedin) }, { data: answer(linkedin) }],
    });
    await t.editorialProfiles.upsert(t.broker.id, {
      ...editorialProfileView(t.broker.id, null),
      facts: ["AgentPey publica en LinkedIn y X"],
      cadence: { linkedin: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 } },
    });
    const first = await t.request();
    await draftPost(t.deps, { contentRunId: first.run.id, isLastAttempt: false });
    const [content] = await t.current();
    if (content === undefined) throw new Error("sin texto");
    await approveContent(t.approveDeps, { contentId: content.id, actor: "operator" });
    expect((await t.posts.get(t.post.id))?.status).toBe("ready");

    expect(codeOf(await caught(t.request()))).toBe("CONTENT_EDITED");
    const second = await t.request(true);
    const result = await draftPost(t.deps, { contentRunId: second.run.id, isLastAttempt: false });

    expect(result).toMatchObject({ outcome: "succeeded", postStatus: "draft" });
    expect((await t.posts.get(t.post.id))?.status).toBe("draft");
    expect((await t.current()).map((item) => item.status)).toEqual(["draft"]);
  });

  it("si le queda otro texto vigente aprobado (de una red que no se redactó), sigue ready", async () => {
    const t = await setup({
      accounts: [],
      llm: [
        {
          data: answer([
            { platform: "x", language: "es" },
            { platform: "linkedin", language: "es" },
          ]),
        },
        { data: answer(linkedin) },
      ],
    });
    const cadence = (platforms: PostPlatform[]) =>
      Object.fromEntries(
        platforms.map((p) => [p, { postsPerWeek: 1, days: [], hours: [], languageGapHours: 6 }]),
      );
    const save = (platforms: PostPlatform[]) =>
      t.editorialProfiles.upsert(t.broker.id, {
        ...editorialProfileView(t.broker.id, null),
        facts: ["AgentPey publica en LinkedIn y X"],
        cadence: cadence(platforms),
      });
    await save(["x", "linkedin"]);
    const first = await t.request();
    await draftPost(t.deps, { contentRunId: first.run.id, isLastAttempt: false });
    for (const content of await t.current()) {
      await approveContent(t.approveDeps, { contentId: content.id, actor: "operator" });
    }
    // X deja de estar en la cadencia: la segunda corrida solo redacta LinkedIn.
    await save(["linkedin"]);
    const second = await t.request(true);
    const result = await draftPost(t.deps, { contentRunId: second.run.id, isLastAttempt: false });

    expect(result).toMatchObject({ outcome: "succeeded", postStatus: "ready" });
    expect((await t.current()).map((item) => [item.platform, item.status])).toEqual([
      ["x", "approved"],
      ["linkedin", "draft"],
    ]);
  });
});

describe("AppError de la corrida", () => {
  it("el error guardado no trae datos del post", async () => {
    const t = await setup({
      accounts: ["linkedin"],
      llm: [{ error: new AppError("LLM_REQUEST_REJECTED", "La API rechazó /Users/vinny/secreto") }],
    });
    const { run } = await t.request();
    await caught(draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false }));
    expect((await t.contentRuns.get(run.id))?.error?.message).not.toContain("/Users/vinny");
  });
});

describe("draftPost · las redes que sirven al post (F9-T20)", () => {
  it("un post de solo texto no se redacta para Instagram, aunque la marca lo tenga", async () => {
    const t = await setup({
      accounts: ["instagram", "x"],
      llm: [{ data: answer([{ platform: "x", language: "es" }]) }],
    });
    const { run } = await t.request();
    await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });
    expect((await t.current()).map((item) => item.platform)).toEqual(["x"]);
  });

  it("con redes propias, solo esas (dentro de las de la marca)", async () => {
    const t = await setup({
      platforms: ["linkedin", "discord"],
      llm: [{ data: answer([{ platform: "linkedin", language: "es" }]) }],
    });
    const { run } = await t.request();
    await draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false });
    // Discord no es de la marca (sin cuenta ni cadencia): queda fuera.
    expect((await t.current()).map((item) => item.platform)).toEqual(["linkedin"]);
  });

  it("si no queda ninguna red que sirva, POST_NO_PLATFORMS sin llamar a la IA", async () => {
    const t = await setup({ accounts: ["instagram"], platforms: ["instagram"] });
    const { run } = await t.request();
    const error = await caught(draftPost(t.deps, { contentRunId: run.id, isLastAttempt: false }));
    expect(codeOf(error)).toBe("POST_NO_PLATFORMS");
    expect(t.llm.requests).toEqual([]);
    expect((await t.contentRuns.get(run.id))?.error?.code).toBe("POST_NO_PLATFORMS");
  });
});
