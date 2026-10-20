import { AppError } from "../errors.js";
import { assertLlmBudget } from "../llm-budget.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { Post } from "../post.js";
import type { User } from "../user.js";
import { assertPostAccess, postNotFound } from "./posts.js";
import {
  type RequestContentRunDeps,
  type RequestContentRunResult,
  requestContentRun,
} from "./request-content-run.js";

// Aceptar o descartar una idea del plan (spec F9 §4.9, ADR-0030 punto 3). Editar el brief o mover
// la fecha de una idea es `updatePost` (F9-T10), que ya sirve para las ideas: editar el brief lo
// deja como del operador (`brief_origin = operator`).

type Actor = Pick<User, "id" | "role" | "brokerId">;

/** `POST_NOT_IDEA` (409): solo una idea sin decidir se acepta o se descarta. */
const notIdea = (post: Pick<Post, "id" | "status">) =>
  new AppError(
    "POST_NOT_IDEA",
    "El post ya no es una idea: solo una idea sin decidir se acepta o se descarta",
    { details: { postId: post.id, status: post.status } },
  );

export type AcceptIdeaDeps = RequestContentRunDeps & {
  /** `markFailed` (la cola no está) y `sumLlmCost` (el tope de IA antes de aceptar). */
  contentRuns: Pick<ContentRunRepository, "markFailed" | "sumLlmCost">;
  posts: Pick<PostRepository, "get">;
  /** Para el tope de IA antes de cambiar nada. */
  brokers: Pick<BrokerRepository, "findById">;
  postLock: PostLock;
};

export type AcceptIdeaResult = { post: Post } & RequestContentRunResult;

/**
 * Acepta una idea (`POST /api/posts/:id/accept`): la idea pasa de `idea` a `draft` y se piden sus
 * textos **igual que al pedir los textos de un post** (`requestContentRun`: la corrida y el job
 * `post.draft`). Aprobar y programar siguen siendo pasos aparte (ADR-0030, puntos 3 y 4).
 * - Lo ajeno no existe (`POST_NOT_FOUND`) y sin `posts.manage` es `FORBIDDEN`;
 * - algo que no es una idea es `POST_NOT_IDEA` (409), sin cambiar nada;
 * - con la marca en su tope de IA del mes, `LLM_BUDGET_EXCEEDED` (409) antes de cambiar nada.
 * Si pedir los textos falla después de aceptar (la cola no está, la base se cortó), la idea queda
 * aceptada en `draft` y el error sube: los textos se piden de nuevo como en cualquier post
 * (`post draft`, "redactar lo aceptado" de T21).
 */
export async function acceptIdea(
  deps: AcceptIdeaDeps,
  actor: Actor,
  postId: string,
): Promise<AcceptIdeaResult> {
  const current = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (current.status !== "idea") throw notIdea(current);
  const broker = await deps.brokers.findById(current.brokerId);
  if (broker !== null) {
    await assertLlmBudget(deps, broker, (deps.now ?? (() => new Date()))());
  }
  const post = await deps.postLock.run(postId, async ({ posts }) => {
    const locked = await posts.get(postId);
    if (locked === null) throw postNotFound(postId);
    if (locked.status !== "idea") throw notIdea(locked);
    return posts.update(postId, { status: "draft" });
  });
  const result = await requestContentRun(deps, { postId });
  return { post, ...result };
}

/**
 * Descarta una idea (`POST /api/posts/:id/discard`): pasa a `archived` y cuenta como descartada
 * para los planes siguientes (`planHistory`: las ideas de la IA archivadas no se proponen otra
 * vez). Lo ajeno no existe (`POST_NOT_FOUND`); algo que no es una idea es `POST_NOT_IDEA` (409):
 * un post aceptado se archiva con `archivePost`.
 */
export async function discardIdea(
  deps: { posts: Pick<PostRepository, "get">; postLock: PostLock },
  actor: Actor,
  postId: string,
): Promise<Post> {
  const current = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (current.status !== "idea") throw notIdea(current);
  return deps.postLock.run(postId, async ({ posts }) => {
    const locked = await posts.get(postId);
    if (locked === null) throw postNotFound(postId);
    if (locked.status !== "idea") throw notIdea(locked);
    return posts.archive(postId);
  });
}
