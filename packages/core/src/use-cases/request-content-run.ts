import type { ContentRun } from "../content.js";
import { AppError, isAppError } from "../errors.js";
import { LISTING_NOT_PREPARABLE_TEXT } from "../labels.js";
import { canPrepareContent } from "../listing.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock } from "../ports/listing-lock.js";
import { PENDING_PUBLICATION_STATUSES } from "../publication-state.js";

export type RequestContentRunDeps = {
  lock: ListingLock;
  /** Fuera del candado: marcar `failed` la corrida si la cola no está (después de confirmar). */
  contentRuns: Pick<ContentRunRepository, "markFailed">;
  queue: JobQueue;
};

export type RequestContentRunParams = {
  listingId: string;
  /** Si la corrida genera textos (por defecto, sí); `false` solo rehace medios y renders. */
  texts?: boolean;
  /** Con `texts`, reemplazar también los textos editados a mano. */
  replaceEdits?: boolean;
};

export type RequestContentRunResult = {
  run: ContentRun;
  /** `true` si ya había una corrida activa del aviso: se devuelve esa (con su propio `texts`). */
  reused: boolean;
};

/**
 * Encola el job de una corrida. Con `singletonKey` (cola `exclusive`) es idempotente: lo usan este
 * caso de uso y el worker, que reencola las corridas en cola al arrancar.
 */
export const enqueueContentRun = (queue: JobQueue, contentRunId: string) =>
  queue.enqueue("content.prepare", { contentRunId }, { singletonKey: contentRunId });

/**
 * Pide una corrida de contenido (spec F2 §4.4 y F3 §4.2). La revisión y la creación corren dentro
 * del candado del aviso, y el job se encola **después**, ya confirmado (pg-boss usa otra conexión):
 * - el aviso debe estar en `ready`, `paused` o `active` y tener al menos una foto
 *   (`LISTING_NOT_READY`, 409);
 * - si ya hay una corrida activa, la devuelve (`reused`) y la **vuelve a encolar** (idempotente con
 *   `singletonKey`), así una corrida cuyo job se perdió (en cola, o en `running` tras un corte en el
 *   último intento) no bloquea el aviso;
 * - con publicaciones pendientes (`PENDING_PUBLICATION_STATUSES`) es `PUBLICATION_PENDING` (409),
 *   también para una corrida de solo imágenes, que reemplazaría los medios fijados (ADR-0014);
 * - con `texts`, un texto vigente editado a mano **o aprobado** da `CONTENT_EDITED` (409) salvo
 *   `replaceEdits`;
 * - si no, crea la corrida en `queued` y encola;
 * - si la cola no está (`QUEUE_UNAVAILABLE`, 503), la corrida nueva queda en `failed` con ese motivo.
 * Con el candado, la ventana de F2 se cerró: un pedido de textos y una edición no se cruzan.
 */
export async function requestContentRun(
  deps: RequestContentRunDeps,
  { listingId, texts = true, replaceEdits = false }: RequestContentRunParams,
): Promise<RequestContentRunResult> {
  const result = await deps.lock.run(listingId, async (locked) => {
    const listing = await locked.listings.get(listingId);
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
    const photos = (await locked.media.listOriginals(listingId)).filter((m) => m.kind === "image");
    if (photos.length === 0) {
      throw new AppError(
        "LISTING_NOT_READY",
        "El aviso no tiene fotos: agrégalas en la carpeta de medios y vuelve a importar",
        { details: { listingId, status: listing.status } },
      );
    }

    const active = await locked.contentRuns.findActive(listingId);
    if (active !== null) return { run: active, reused: true };

    const pending = (await locked.publications.listByListing(listingId)).filter((publication) =>
      (PENDING_PUBLICATION_STATUSES as readonly string[]).includes(publication.status),
    );
    if (pending.length > 0) {
      throw new AppError(
        "PUBLICATION_PENDING",
        "Hay publicaciones aprobadas que no han salido: publícalas o descártalas antes de preparar de nuevo",
        { details: { listingId, publicationIds: pending.map((publication) => publication.id) } },
      );
    }

    if (texts && !replaceEdits) {
      const reviewed = (await locked.contents.listCurrent(listingId)).filter(
        (content) => content.status === "edited" || content.status === "approved",
      );
      if (reviewed.length > 0) {
        throw new AppError(
          "CONTENT_EDITED",
          "Hay textos editados a mano o aprobados: prepara sin textos o confirma que quieres reemplazarlos",
          { details: { listingId, platforms: reviewed.map((content) => content.platform) } },
        );
      }
    }

    return { run: await locked.contentRuns.create({ listingId, texts }), reused: false };
  });

  // Ya confirmado: encolar (también una activa, por si su job se perdió).
  try {
    await enqueueContentRun(deps.queue, result.run.id);
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
