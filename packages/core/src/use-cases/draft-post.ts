import type { AbortSignalLike } from "../abort.js";
import { settlePostStatus } from "../content/locked-content.js";
import { contentRunErrorOf } from "../content/run-error.js";
import type { ContentRun, ContentRunReport } from "../content.js";
import { editorialProfileView } from "../editorial-profile.js";
import { isTerminalContentRun, type PostStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { assertLlmBudget, llmProviderFor } from "../llm-budget.js";
import { llmCallCost } from "../llm-usage.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository, NewContent } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { LLMProvider } from "../ports/llm-provider.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository } from "../ports/post-repository.js";
import { canDraftPost, postNotReady } from "../post.js";
import { buildSocialBrief, postPlatforms, socialTargets } from "../social/brief.js";
import { buildPostCheckContext } from "../social/check.js";
import { draftPostTexts } from "../social/draft-texts.js";
import { kindProblem } from "../social/networks.js";
import { SOCIAL_PROMPT_VERSION } from "../social/prompt.js";
import { postSubject } from "../subject.js";

export type DraftPostDeps = {
  contentRuns: ContentRunRepository;
  posts: Pick<PostRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  media: Pick<MediaRepository, "listBySubject">;
  /** Para guardar los textos y dejar el estado del post al día en una sola transacción. */
  postLock: PostLock;
  /** El proveedor del operador (`LLM_PROVIDER`): el de sus marcas propias (spec F7 §4.7). */
  llm: LLMProvider;
  /** La API de Anthropic para las marcas que no son del operador; `null` sin la clave. */
  apiLlm?: LLMProvider | null;
  /** Reloj en milisegundos, para la duración de la llamada a la IA. */
  now?: () => number;
  /** La fecha del tope de IA del mes (F7-T12). Por defecto, la actual. */
  clock?: () => Date;
};

export type DraftPostParams = {
  contentRunId: string;
  /** Último intento del job: un error deja la corrida en `failed`. */
  isLastAttempt: boolean;
  /** El del worker: se dispara al apagarse. */
  signal?: AbortSignalLike;
};

export type DraftPostResult =
  | { outcome: "succeeded"; report: ContentRunReport; postStatus: PostStatus }
  /** La corrida ya estaba terminada, o un intento solapado guardó antes: no se hizo nada. */
  | { outcome: "skipped"; status: ContentRun["status"] };

/** La corrida ya no está en `running` (la cerró otro intento): este intento termina `skipped`. */
class RunClosed extends Error {}

const aborted = (cause?: unknown) =>
  new AppError("CONTENT_RUN_ABORTED", "Se cortó la corrida de textos del post", {
    retriable: true,
    ...(cause === undefined ? {} : { cause }),
  });

const normalized = (error: unknown): AppError =>
  isAppError(error)
    ? error
    : new AppError("INTERNAL_ERROR", "Error interno al redactar los textos del post", {
        cause: error,
      });

/**
 * Redacta los textos de un post (el handler del job `post.draft`, spec F9 §4.4 y §4.9, ADR-0030):
 * solo la etapa `texts`, porque los medios de un post se procesan al subirlos (`post.media`).
 * 1. Lee el post (en `draft` o `ready`, si no `POST_NOT_READY`), su marca, su perfil editorial,
 *    sus cuentas y sus medios. Las redes son las de `postPlatforms` (`POST_NO_PLATFORMS` si no
 *    hay ninguna) y se redacta un texto por red e idioma del perfil.
 * 2. Llama a la IA con el proveedor de la marca (`llmProviderFor`), revisa el tope del mes antes
 *    de cada llamada (`LLM_BUDGET_EXCEEDED`, F7) y anota cada llamada en la corrida en cuanto
 *    vuelve: el gasto queda por marca (`sumLlmCost` cruza la corrida con el post).
 * 3. En el candado del post, guarda los textos en `draft` con el paso a `succeeded` y deja el
 *    estado del post al día (`settlePostStatus`): si la corrida reemplazó textos aprobados (pedida
 *    con `replaceEdits`), el post vuelve a `draft` salvo que le quede otro texto vigente aprobado.
 * Como `prepareContent`: una corrida terminal no se toca (`skipped`); un error no reintentable, o
 * el del último intento, deja la corrida en `failed`, salvo que el worker se esté apagando
 * (`signal`): entonces relanza como reintentable sin tocarla. Una corrida de aviso aquí es
 * `SUBJECT_NOT_POST`, no reintentable, sin tocar la corrida (es de `content.prepare`).
 */
export async function draftPost(
  deps: DraftPostDeps,
  { contentRunId, isLastAttempt, signal }: DraftPostParams,
): Promise<DraftPostResult> {
  const run = await deps.contentRuns.get(contentRunId);
  if (run === null) {
    throw new AppError("CONTENT_RUN_NOT_FOUND", `No existe la corrida ${contentRunId}`, {
      details: { contentRunId },
    });
  }
  if (isTerminalContentRun(run.status)) return { outcome: "skipped", status: run.status };
  if (run.subject.kind !== "post") {
    throw new AppError("SUBJECT_NOT_POST", "Esa corrida es de un aviso, no de un post", {
      details: { contentRunId, listingId: run.subject.id },
    });
  }
  const postId = run.subject.id;
  if (!(await deps.contentRuns.markRunning(run.id))) return skipped(deps, run);

  const report: ContentRunReport = { warnings: [] };
  try {
    if (signal?.aborted) throw aborted();
    if (!(await deps.contentRuns.setStage(run.id, "texts"))) throw new RunClosed();
    const contents = await texts(deps, { runId: run.id, postId, report, signal });
    if (signal?.aborted) throw aborted();
    const saved = await deps.postLock.run(postId, async (repos) => {
      if (!(await repos.contentRuns.markSucceeded(run.id, { report, contents }))) return null;
      const post = await repos.posts.get(postId);
      return post === null ? null : (await settlePostStatus(repos, post)).status;
    });
    if (saved === null) return skipped(deps, run);
    return { outcome: "succeeded", report, postStatus: saved };
  } catch (caught) {
    if (caught instanceof RunClosed) return skipped(deps, run);
    const error = normalized(caught);
    if (signal?.aborted) throw error.retriable ? error : aborted(error);
    if (!error.retriable || isLastAttempt) {
      await deps.contentRuns
        .markFailed(run.id, contentRunErrorOf(error), report)
        .catch(() => false);
    }
    throw error;
  }
}

async function skipped(deps: DraftPostDeps, run: ContentRun): Promise<DraftPostResult> {
  const current = await deps.contentRuns.get(run.id);
  return { outcome: "skipped", status: current?.status ?? run.status };
}

/** La etapa `texts`: el brief, la IA con su tope y su gasto, y la revisión (en el reporte, solo códigos). */
async function texts(
  deps: DraftPostDeps,
  state: {
    runId: string;
    postId: string;
    report: ContentRunReport;
    signal: AbortSignalLike | undefined;
  },
): Promise<NewContent[]> {
  const post = await deps.posts.get(state.postId);
  if (post === null) {
    throw new AppError("POST_NOT_FOUND", `No existe el post ${state.postId}`, {
      details: { postId: state.postId },
    });
  }
  if (!canDraftPost(post.status)) throw postNotReady(post);
  const broker = await deps.brokers.findById(post.brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe la marca del post", {
      details: { postId: post.id },
    });
  }
  const profile = editorialProfileView(broker.id, await deps.editorialProfiles.get(broker.id));
  const brandPlatforms = postPlatforms(
    profile,
    await deps.platformAccounts.listByBroker(broker.id),
  );
  if (brandPlatforms.length === 0) {
    throw new AppError(
      "POST_NO_PLATFORMS",
      "La marca no tiene redes para este post: conecta una cuenta o define la cadencia de una red en su perfil editorial",
      { details: { postId: post.id } },
    );
  }
  // F9-T20: las redes del post (las que sugirió el plan, o las que fijó el operador) dentro de las
  // de la marca, y solo las que sirven al tipo del post (Instagram no publica solo texto; TikTok,
  // solo video).
  const platforms = brandPlatforms.filter(
    (platform) =>
      (post.platforms === null || post.platforms.includes(platform)) &&
      kindProblem(platform, post.kind) === null,
  );
  if (platforms.length === 0) {
    throw new AppError(
      "POST_NO_PLATFORMS",
      "Ninguna red del post sirve: revisa sus redes o su tipo (Instagram necesita imagen o video; TikTok, video)",
      { details: { postId: post.id, kind: post.kind } },
    );
  }
  const targets = socialTargets(platforms, profile.languages);
  const ctx = buildPostCheckContext({
    post,
    profile,
    broker,
    media: await deps.media.listBySubject(postSubject(post.id)),
  });
  const brief = buildSocialBrief({ post, profile, broker, targets });

  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => new Date());
  const started = now();
  // El proveedor de la marca y su tope del mes antes de cada llamada (spec F7 §4.7), con la marca
  // releída: el tope pudo cambiar entre medio.
  const llm = llmProviderFor(broker, { own: deps.llm, api: deps.apiLlm ?? null });
  const result = await draftPostTexts(
    {
      llm,
      beforeCall: async () => {
        const current = (await deps.brokers.findById(broker.id)) ?? broker;
        await assertLlmBudget(deps, current, clock());
      },
      // Cada llamada se anota en cuanto vuelve: también las que fallan después (se cobraron).
      onUsage: async (model, usage) => {
        await deps.contentRuns.addLlmUsage(state.runId, llmCallCost(llm.name, model, usage));
      },
    },
    { brief, ctx, ...(state.signal === undefined ? {} : { signal: state.signal }) },
  );
  state.report.llm = {
    provider: llm.name,
    model: result.model,
    promptVersion: SOCIAL_PROMPT_VERSION,
    attempts: result.attempts,
    durationMs: Math.max(0, Math.round(now() - started)),
  };
  state.report.warnings.push(...result.draft.warnings);
  state.report.postChecks = result.texts.map(({ platform, language, checks }) => ({
    platform,
    language,
    codes: checks.map((check) => check.code),
  }));
  return result.texts.map((text) => ({
    platform: text.platform,
    language: text.language,
    title: null,
    body: text.body,
    hashtags: text.hashtags,
    llmProvider: llm.name,
    llmModel: result.model,
    promptVersion: SOCIAL_PROMPT_VERSION,
    rawOutput: result.draft,
  }));
}
