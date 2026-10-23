import { editorialProfileView } from "../editorial-profile.js";
import { AppError, isAppError } from "../errors.js";
import {
  assertImageAiBudget,
  type ImageAiPricing,
  imageAiSpentThisMonth,
  wouldPassImageAiCap,
} from "../image-ai-budget.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import type { StockPhoto, StockPhotoProvider } from "../ports/post-image-sources.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository } from "../ports/post-repository.js";
import { canDraftPost, type Post, postNotReady } from "../post.js";
import { describeCardPlan, postCardPlan } from "../post-cards.js";
import {
  isActivePostImageRun,
  POST_IMAGE_LIMITS,
  type PostImageRequest,
  type PostImageRun,
  postCardsInUse,
  postImageNotNeeded,
  postImageRunActive,
  postImageSourceNotConfigured,
  postImageSuggestions,
} from "../post-image.js";
import { postSubject } from "../subject.js";
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
  /** Los textos vigentes y el idioma principal de la marca: de ahí salen las tarjetas. */
  contents: Pick<ContentRepository, "listCurrent">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  /** Los medios del post (para contar sus tarjetas). */
  media: Pick<MediaRepository, "listBySubject">;
  runs: PostImageRunRepository;
  queue: JobQueue;
  sources: PostImageSourcesConfig;
  /** Quitar las tarjetas anteriores: en el candado del post, y después sus archivos en R2. */
  postLock: PostLock;
  storage: Pick<MediaStorage, "delete">;
  now?: () => Date;
};

/** Cuántos pedidos de un post se leen para saber cuáles de sus medios son tarjetas. */
const ALL_RUNS = 500;

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
  /**
   * Las tarjetas de la marca antes de pedirlas: cuántas saldrían y por qué (`message`, listo para
   * mostrar: «4 tarjetas: X admite hasta 4 imágenes por post (…)»), y cuántas tarjetas de pedidos
   * anteriores tiene ya el post (`existing`, lo que «Quitar las tarjetas anteriores» borraría).
   * `count` es `null` si todavía no se pueden armar (un video sin texto redactado).
   */
  cards: { count: number | null; message: string; existing: number } | null;
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

/**
 * Los ids de los medios del post que son tarjetas: los de sus pedidos de tarjetas terminados que
 * siguen siendo originales del post. Lo que el usuario subió, una foto de la biblioteca o una imagen
 * con IA nunca está aquí (el post no guarda de dónde salió un medio: lo dicen los pedidos).
 */
async function cardMediaIds(
  deps: Pick<PostImageDeps, "runs" | "media">,
  postId: string,
): Promise<string[]> {
  const runs = await deps.runs.listByPost(postId, ALL_RUNS);
  const fromCards = new Set(
    runs
      .filter((run) => run.source === "card" && run.status === "succeeded")
      .flatMap((run) => run.mediaIds),
  );
  if (fromCards.size === 0) return [];
  const all = await deps.media.listBySubject(postSubject(postId));
  return all.filter((item) => item.role === "original" && fromCards.has(item.id)).map((i) => i.id);
}

/** El plan de tarjetas del post (cuántas y por qué), o `null` si todavía no se puede armar. */
async function cardsInfo(deps: PostImageDeps, post: Post): Promise<PostImageOptions["cards"]> {
  if (post.kind === "text") return null;
  const existing = (await cardMediaIds(deps, post.id)).length;
  const broker = await deps.brokers.findById(post.brokerId);
  if (broker === null) return null;
  const profile = editorialProfileView(broker.id, await deps.editorialProfiles.get(broker.id));
  const contents = await deps.contents.listCurrent(postSubject(post.id));
  try {
    const [language] = profile.languages;
    const plan = postCardPlan(
      { ...post, kind: post.kind },
      contents,
      broker,
      language === undefined ? {} : { language },
    );
    return {
      count: plan.cards.length,
      message: describeCardPlan(plan, post.kind),
      existing,
    };
  } catch (error) {
    // Un video sin texto redactado: se dice en simple, no es un error de la pantalla.
    if (isAppError(error) && error.code === "POST_IMAGE_NEEDS_TEXT") {
      return {
        count: null,
        message: "Para el video de las tarjetas hace falta el texto redactado: pídelo primero.",
        existing,
      };
    }
    throw error;
  }
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
    cards: await cardsInfo(deps, post),
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

/** `POST_IMAGE_RUN_ACTIVE` si el último pedido del post sigue en cola o consiguiéndose. */
async function assertNoActiveRun(deps: Pick<PostImageDeps, "runs">, postId: string) {
  const [latest] = await deps.runs.listByPost(postId, 1);
  if (latest !== undefined && isActivePostImageRun(latest)) {
    throw postImageRunActive(postId, latest.id);
  }
}

/** Las publicaciones que ya usan los medios del post (o los usaron): no se les quitan imágenes. */
const KEEPS_ITS_MEDIA = new Set([
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "paused",
  "outcome_unknown",
]);

/**
 * Quita del post sus tarjetas (los medios de sus pedidos de tarjetas terminados) con sus variantes,
 * en el candado del post, y después sus archivos de R2 (si uno no se puede borrar, queda suelto en
 * el bucket sin afectar al post). Si alguna publicación aprobada, programada o publicada las usa,
 * `POST_CARDS_IN_USE` y no se borra nada. Devuelve cuántas tarjetas quitó.
 */
async function removeCardsOf(deps: PostImageDeps, postId: string): Promise<number> {
  const ids = await cardMediaIds(deps, postId);
  if (ids.length === 0) return 0;
  const paths = await deps.postLock.run(postId, async (repos) => {
    const publications = await repos.publications.listBySubject(postSubject(postId));
    if (publications.some((publication) => KEEPS_ITS_MEDIA.has(publication.status))) {
      throw postCardsInUse(postId);
    }
    return repos.media.deleteOriginals(postSubject(postId), ids);
  });
  await Promise.allSettled(paths.map((path) => deps.storage.delete(path)));
  return ids.length;
}

/**
 * Quita las tarjetas anteriores de un post (`DELETE /posts/:id/images/cards`): solo los medios que
 * salieron de sus pedidos de tarjetas, nunca una foto o un video que el usuario subió ni una foto de
 * la biblioteca o una imagen con IA. Con otro pedido en curso, `POST_IMAGE_RUN_ACTIVE`; con
 * publicaciones que las usan, `POST_CARDS_IN_USE`. Sin tarjetas, no hace nada (`removed: 0`).
 */
export async function removePostCards(
  deps: PostImageDeps,
  actor: Actor,
  postId: string,
): Promise<{ removed: number }> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (post.status === "archived") throw postArchived(postId);
  if (!canDraftPost(post.status)) throw postNotReady(post);
  await assertNoActiveRun(deps, post.id);
  return { removed: await removeCardsOf(deps, post.id) };
}

/**
 * Pide imágenes para un post (`POST /posts/:id/images`): deja el pedido en cola y encola
 * `post.image` (el worker las consigue y las agrega como medios). En un post de video, las tarjetas
 * van en 9:16 y el worker arma el video. Sin la clave de la biblioteca o de la IA,
 * `POST_IMAGE_SOURCE_NOT_CONFIGURED`; con la IA en el tope, `IMAGE_AI_BUDGET_EXCEEDED`; con otro
 * pedido en curso, `POST_IMAGE_RUN_ACTIVE`. Unas tarjetas con `replaceCards` quitan antes las
 * anteriores del post (`removePostCards`). Si no se pudo encolar, el pedido queda `failed`.
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
  if (request.source === "card" && request.replaceCards === true) {
    // Con otro pedido en curso no se quita nada: se avisa antes de borrar.
    await assertNoActiveRun(deps, post.id);
    await removeCardsOf(deps, post.id);
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
