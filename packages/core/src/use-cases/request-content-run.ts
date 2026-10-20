import type { ContentRun } from "../content.js";
import { AppError, isAppError } from "../errors.js";
import { LISTING_NOT_PREPARABLE_TEXT } from "../labels.js";
import { canPrepareContent } from "../listing.js";
import { assertLlmBudget } from "../llm-budget.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import { canDraftPost, postNotReady } from "../post.js";
import { PENDING_PUBLICATION_STATUSES } from "../publication-state.js";
import { listingSubject, type Subject, type SubjectInput, subjectOfInput } from "../subject.js";
import {
  type LockedSubject,
  runOnSubject,
  type SubjectLockedRepositories,
  type SubjectLocks,
} from "../subject-lock.js";

export type RequestContentRunDeps = SubjectLocks & {
  /** Fuera del candado: marcar `failed` la corrida si la cola no está (después de confirmar). */
  contentRuns: Pick<ContentRunRepository, "markFailed">;
  queue: JobQueue;
  /** El reloj del tope de IA del mes (F7-T12); por defecto, la hora actual. */
  now?: () => Date;
};

/**
 * El aviso (`listingId`, como antes de F9) o el post (`postId`, ADR-0029) y lo que se pide.
 */
export type RequestContentRunParams = SubjectInput & {
  /**
   * Si la corrida genera textos (por defecto, sí); `false` solo rehace medios y renders de un
   * aviso. Un post solo pide textos (sus medios se procesan al subirlos, spec F9 §4.5).
   */
  texts?: boolean;
  /** Con `texts`, reemplazar también los textos editados a mano. */
  replaceEdits?: boolean;
};

export type RequestContentRunResult = {
  run: ContentRun;
  /** `true` si ya había una corrida activa del aviso o post: se devuelve esa (con su `texts`). */
  reused: boolean;
};

/**
 * Encola el job de una corrida de un aviso (`content.prepare`). Con `singletonKey` (cola
 * `exclusive`) es idempotente: lo usan este caso de uso y el worker, que reencola las corridas en
 * cola al arrancar.
 */
export const enqueueContentRun = (queue: JobQueue, contentRunId: string) =>
  queue.enqueue("content.prepare", { contentRunId }, { singletonKey: contentRunId });

/**
 * Encola el job de una corrida de un post (`post.draft`, spec F9 §4.9), idempotente con
 * `singletonKey` como `enqueueContentRun`. Una corrida de post nunca va por `content.prepare`.
 */
export const enqueuePostDraft = (queue: JobQueue, contentRunId: string) =>
  queue.enqueue("post.draft", { contentRunId }, { singletonKey: contentRunId });

/** El job de una corrida según su sujeto: `content.prepare` (aviso) o `post.draft` (post). */
export const enqueueRunOf = (queue: JobQueue, run: Pick<ContentRun, "id" | "subject">) =>
  run.subject.kind === "post" ? enqueuePostDraft(queue, run.id) : enqueueContentRun(queue, run.id);

/**
 * Pide una corrida de contenido (spec F2 §4.4 y F3 §4.2) de un aviso o, desde F9, de un post
 * (ADR-0029). La revisión y la creación corren dentro del candado de su sujeto, y el job se encola
 * **después**, ya confirmado (pg-boss usa otra conexión): `content.prepare` para un aviso y
 * `post.draft` para un post.
 * - el aviso debe estar en `ready`, `paused` o `active` y tener al menos una foto
 *   (`LISTING_NOT_READY`, 409); el post, en `draft` o `ready` (`POST_NOT_READY`, 409), con o sin
 *   medios, y solo pide textos (`texts: false` es `CONTENT_RUN_INVALID`, 400);
 * - si ya hay una corrida activa, la devuelve (`reused`) y la **vuelve a encolar** (idempotente con
 *   `singletonKey`), así una corrida cuyo job se perdió (en cola, o en `running` tras un corte en el
 *   último intento) no bloquea el aviso ni el post;
 * - con publicaciones pendientes (`PENDING_PUBLICATION_STATUSES`) es `PUBLICATION_PENDING` (409),
 *   también para una corrida de solo imágenes, que reemplazaría los medios fijados (ADR-0014);
 * - con `texts`, un texto vigente editado a mano **o aprobado** da `CONTENT_EDITED` (409) salvo
 *   `replaceEdits`;
 * - con `texts`, un corredor o marca que llegó a su tope de IA del mes da `LLM_BUDGET_EXCEEDED`
 *   (409, F7-T12; el worker lo revisa otra vez antes de llamar);
 * - si no, crea la corrida en `queued` y encola;
 * - si la cola no está (`QUEUE_UNAVAILABLE`, 503), la corrida nueva queda en `failed` con ese motivo.
 * Con el candado, la ventana de F2 se cerró: un pedido de textos y una edición no se cruzan.
 */
export async function requestContentRun(
  deps: RequestContentRunDeps,
  { texts = true, replaceEdits = false, ...input }: RequestContentRunParams,
): Promise<RequestContentRunResult> {
  const subject = subjectOfInput(input);
  if (subject.kind === "post" && !texts) {
    throw new AppError("CONTENT_RUN_INVALID", "Un post solo pide textos", {
      details: { postId: subject.id },
    });
  }
  const result = await runOnSubject(deps, subject, async (locked) => {
    // Lo propio de cada sujeto: si puede preparar contenido, y de qué corredor es el gasto.
    const brokerId = await preparableBrokerOf(locked);

    const active = await locked.repos.contentRuns.findActive(subject);
    if (active !== null) return { run: active, reused: true };

    await assertNothingPending(locked.repos, subject);

    if (texts && !replaceEdits) {
      const reviewed = (await locked.repos.contents.listCurrent(subject)).filter(
        (content) => content.status === "edited" || content.status === "approved",
      );
      if (reviewed.length > 0) {
        throw new AppError(
          "CONTENT_EDITED",
          "Hay textos editados a mano o aprobados: prepara sin textos o confirma que quieres reemplazarlos",
          { details: { ...idDetails(subject), platforms: reviewed.map((c) => c.platform) } },
        );
      }
    }

    if (texts) {
      const broker = await locked.repos.brokers.findById(brokerId);
      if (broker !== null) {
        await assertLlmBudget(locked.repos, broker, (deps.now ?? (() => new Date()))());
      }
    }

    const run = await locked.repos.contentRuns.create(
      subject.kind === "listing"
        ? { listingId: subject.id, texts }
        : { postId: subject.id, texts: true },
    );
    return { run, reused: false };
  });

  // Ya confirmado: encolar (también una activa, por si su job se perdió).
  try {
    await enqueueRunOf(deps.queue, result.run);
  } catch (error) {
    if (!result.reused && isAppError(error) && error.code === "QUEUE_UNAVAILABLE") {
      // Si además falla la base, igual se informa el error de la cola: es la causa.
      await deps.contentRuns
        .markFailed(result.run.id, { code: error.code, message: error.message })
        .catch(() => false);
    }
    throw error;
  }
  return result;
}

/** `listingId` o `postId` en los detalles de un error, como antes de F9 en los avisos. */
const idDetails = (subject: Subject) =>
  subject.kind === "listing" ? { listingId: subject.id } : { postId: subject.id };

/**
 * Si el sujeto puede preparar contenido, y su corredor. Aviso: en `ready`, `paused` o `active` y
 * con al menos una foto (`LISTING_NOT_READY`). Post: en `draft` o `ready` (`POST_NOT_READY`).
 */
async function preparableBrokerOf(locked: LockedSubject): Promise<string> {
  if (locked.kind === "post") {
    const post = await locked.repos.posts.get(locked.subject.id);
    if (post === null) {
      throw new AppError("POST_NOT_FOUND", `No existe el post ${locked.subject.id}`, {
        details: { postId: locked.subject.id },
      });
    }
    if (!canDraftPost(post.status)) throw postNotReady(post);
    return post.brokerId;
  }
  const listingId = locked.subject.id;
  const listing = await locked.repos.listings.get(listingId);
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${listingId}`, {
      details: { listingId },
    });
  }
  if (!canPrepareContent(listing.status)) {
    throw new AppError("LISTING_NOT_READY", LISTING_NOT_PREPARABLE_TEXT, {
      details: { listingId, status: listing.status },
    });
  }
  const photos = (await locked.repos.media.listOriginals(listingSubject(listingId))).filter(
    (m) => m.kind === "image",
  );
  if (photos.length === 0) {
    throw new AppError(
      "LISTING_NOT_READY",
      "El aviso no tiene fotos: agrégalas en la carpeta de medios y vuelve a importar",
      { details: { listingId, status: listing.status } },
    );
  }
  return listing.brokerId;
}

/** Sin publicaciones aprobadas que no han salido (ADR-0014): `PUBLICATION_PENDING`. */
async function assertNothingPending(
  repos: SubjectLockedRepositories,
  subject: Subject,
): Promise<void> {
  const pending = (await repos.publications.listBySubject(subject)).filter((publication) =>
    (PENDING_PUBLICATION_STATUSES as readonly string[]).includes(publication.status),
  );
  if (pending.length > 0) {
    throw new AppError(
      "PUBLICATION_PENDING",
      "Hay publicaciones aprobadas que no han salido: publícalas o descártalas antes de preparar de nuevo",
      {
        details: {
          ...idDetails(subject),
          publicationIds: pending.map((publication) => publication.id),
        },
      },
    );
  }
}
