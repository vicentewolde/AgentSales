import { AppError } from "../errors.js";
import {
  assertImageAiBudget,
  type ImageAiPricing,
  imageAiSpentThisMonth,
  wouldPassImageAiCap,
} from "../image-ai-budget.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import type { StockPhoto, StockPhotoProvider } from "../ports/post-image-sources.js";
import type { PostRepository } from "../ports/post-repository.js";
import { canDraftPost, type Post, postNotReady } from "../post.js";
import {
  POST_IMAGE_LIMITS,
  type PostImageRequest,
  type PostImageRun,
  postImageNotNeeded,
  postImageSourceNotConfigured,
  postImageSuggestions,
} from "../post-image.js";
import type { User } from "../user.js";
import { assertPostAccess } from "./posts.js";

// Conseguir imágenes para un post (F9.5-T25, ADR-0038), del lado de la API: qué fuentes hay, buscar
// en la biblioteca y pedir. Lo que se consigue lo hace el worker (`post.image`, `runPostImage`).

type Actor = Pick<User, "id" | "role" | "brokerId">;

/**
 * Las fuentes que el servidor tiene configuradas: la biblioteca (sin `PIXABAY_API_KEY`, `null`) y
 * el precio y el tope de la IA (sin `GEMINI_API_KEY`, `null`). Las tarjetas no piden nada.
 */
export type PostImageSourcesConfig = {
  stock: StockPhotoProvider | null;
  ai: ImageAiPricing | null;
};

export type PostImageDeps = {
  posts: Pick<PostRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  runs: PostImageRunRepository;
  queue: JobQueue;
  sources: PostImageSourcesConfig;
  now?: () => Date;
};

/** Lo que el panel y la CLI muestran antes de pedir. */
export type PostImageOptions = {
  sources: {
    card: { available: true };
    stock: { available: boolean; missing: string | null };
    ai: {
      available: boolean;
      missing: string | null;
      /** Precio de una imagen y tope del mes (`null` sin la clave). */
      priceUsd: number | null;
      capUsd: number | null;
      spentUsd: number;
      /** Otra imagen ya no cabe en el tope del mes. */
      capReached: boolean;
    };
  };
  /** Lo que se propone buscar y pedir (editable). */
  suggestions: { query: string; prompt: string };
  /** Los últimos pedidos del post, del más nuevo al más viejo. */
  runs: PostImageRun[];
};

const postArchived = (postId: string) =>
  new AppError("POST_ARCHIVED", "El post está archivado: ya no recibe medios", {
    details: { postId },
  });

/** El post, si el usuario puede y si puede recibir medios (borrador o listo, y no de texto). */
async function usablePost(deps: Pick<PostImageDeps, "posts">, actor: Actor, postId: string) {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (post.status === "archived") throw postArchived(postId);
  if (!canDraftPost(post.status)) throw postNotReady(post);
  if (post.kind === "text") throw postImageNotNeeded(postId);
  return post as Post & { kind: Exclude<Post["kind"], "text"> };
}

/** Las fuentes, lo propuesto y los últimos pedidos (`GET /posts/:id/images`). */
export async function getPostImageOptions(
  deps: PostImageDeps,
  actor: Actor,
  postId: string,
): Promise<PostImageOptions> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  const now = (deps.now ?? (() => new Date()))();
  const ai = deps.sources.ai;
  const spentUsd = await imageAiSpentThisMonth(deps.runs, post.brokerId, now);
  return {
    sources: {
      card: { available: true },
      stock: {
        available: deps.sources.stock !== null,
        missing: deps.sources.stock === null ? "PIXABAY_API_KEY" : null,
      },
      ai: {
        available: ai !== null,
        missing: ai === null ? "GEMINI_API_KEY" : null,
        priceUsd: ai?.priceUsd ?? null,
        capUsd: ai?.monthlyCapUsd ?? null,
        spentUsd,
        capReached: ai !== null && wouldPassImageAiCap(spentUsd, ai),
      },
    },
    suggestions: postImageSuggestions(post),
    runs: await deps.runs.listByPost(post.id, POST_IMAGE_LIMITS.runsShown),
  };
}

/**
 * Palabras de las etiquetas de una foto que dicen que tiene personas (Pixabay etiqueta en inglés y,
 * con `lang=es`, en español). El filtro «sin personas» es sugerido: se puede quitar.
 */
const PEOPLE_TAGS =
  /\b(people|person|persons|man|men|woman|women|girl|girls|boy|boys|child|children|kid|kids|baby|family|couple|portrait|face|model|businessman|businesswoman|persona|personas|hombre|hombres|mujer|mujeres|niña|niño|niños|niñas|bebé|familia|pareja|retrato|cara|modelo)\b/iu;

export const hasPeople = (photo: Pick<StockPhoto, "tags">): boolean =>
  photo.tags.some((tag) => PEOPLE_TAGS.test(tag));

/**
 * Busca fotos en la biblioteca para un post (`GET /posts/:id/images/stock`): hasta
 * `POST_IMAGE_LIMITS.stockResults`; con `withoutPeople`, sin las que llevan personas en sus
 * etiquetas (se piden más para que queden suficientes). Es una lectura: no anota nada.
 */
export async function searchStockPhotos(
  deps: Pick<PostImageDeps, "posts" | "sources">,
  actor: Actor,
  postId: string,
  input: { text: string; withoutPeople: boolean },
): Promise<StockPhoto[]> {
  await usablePost(deps, actor, postId);
  const stock = deps.sources.stock;
  if (stock === null) throw postImageSourceNotConfigured("stock");
  const text = input.text.trim().slice(0, POST_IMAGE_LIMITS.queryMaxChars);
  if (text === "") {
    throw new AppError("POST_IMAGE_INVALID", "Escribe qué buscar en la biblioteca");
  }
  const found = await stock.search({ text, perPage: input.withoutPeople ? 48 : 12 });
  return (input.withoutPeople ? found.filter((photo) => !hasPeople(photo)) : found).slice(
    0,
    POST_IMAGE_LIMITS.stockResults,
  );
}

/**
 * Pide imágenes para un post (`POST /posts/:id/images`): deja el pedido en cola y encola
 * `post.image` (el worker las consigue y las agrega como medios). En un post de video, las tarjetas
 * van en 9:16 y el worker arma el video. Sin la clave de la biblioteca o de la IA,
 * `POST_IMAGE_SOURCE_NOT_CONFIGURED`; con la IA en el tope, `IMAGE_AI_BUDGET_EXCEEDED`; con otro
 * pedido en curso, `POST_IMAGE_RUN_ACTIVE`. Si no se pudo encolar, el pedido queda `failed`.
 */
export async function requestPostImage(
  deps: PostImageDeps,
  actor: Actor,
  postId: string,
  request: PostImageRequest,
): Promise<PostImageRun> {
  const post = await usablePost(deps, actor, postId);
  if (post.kind === "video" && request.source !== "card") {
    throw new AppError(
      "POST_IMAGE_INVALID",
      "Un post de video usa el video de las tarjetas o un video subido, no una foto",
      { details: { postId } },
    );
  }
  if (request.source === "stock" && deps.sources.stock === null) {
    throw postImageSourceNotConfigured("stock");
  }
  if (request.source === "ai") {
    const pricing = deps.sources.ai;
    if (pricing === null) throw postImageSourceNotConfigured("ai");
    const broker = await deps.brokers.findById(post.brokerId);
    if (broker === null) throw postNotReady(post);
    await assertImageAiBudget(deps, broker, pricing, (deps.now ?? (() => new Date()))());
  }
  const normalized: PostImageRequest =
    request.source === "card" && post.kind === "video" ? { ...request, format: "9:16" } : request;
  const run = await deps.runs.create({
    postId: post.id,
    brokerId: post.brokerId,
    source: normalized.source,
    request: normalized,
    createdBy: actor.id,
  });
  try {
    await deps.queue.enqueue("post.image", { postImageRunId: run.id }, { singletonKey: run.id });
  } catch (cause) {
    await deps.runs.markFailed(run.id, {
      code: "QUEUE_UNAVAILABLE",
      message: "No se pudo encolar el pedido: vuelve a intentarlo",
    });
    throw new AppError("QUEUE_UNAVAILABLE", "No se pudo encolar el pedido: vuelve a intentarlo", {
      retriable: true,
      cause,
    });
  }
  return run;
}

/**
 * Un pedido de imágenes de un post (`GET /posts/:id/images/:runId`): con el acceso al post, y solo si
 * el pedido es de ese post (si no, `POST_IMAGE_RUN_NOT_FOUND`, 404).
 */
export async function getPostImageRun(
  deps: Pick<PostImageDeps, "posts" | "runs">,
  actor: Actor,
  postId: string,
  runId: string,
): Promise<PostImageRun> {
  assertPostAccess(actor, await deps.posts.get(postId), postId);
  const run = await deps.runs.get(runId);
  if (run === null || run.postId !== postId) {
    throw new AppError("POST_IMAGE_RUN_NOT_FOUND", "No existe ese pedido de imágenes", {
      details: { postId, runId },
    });
  }
  return run;
}
