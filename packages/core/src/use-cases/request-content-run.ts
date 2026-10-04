import type { ContentRun } from "../content.js";
import { AppError, isAppError } from "../errors.js";
import { LISTING_NOT_PREPARABLE_TEXT } from "../labels.js";
import { canPrepareContent } from "../listing.js";
import type { ContentRepository, ContentRunRepository } from "../ports/content-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";

export type RequestContentRunDeps = {
  listings: Pick<ListingRepository, "get">;
  media: Pick<MediaRepository, "listOriginals">;
  contentRuns: ContentRunRepository;
  contents: Pick<ContentRepository, "listCurrent">;
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
 * Pide una corrida de contenido (spec F2 §4.4):
 * - el aviso debe estar en `ready`, `paused` o `active` y tener al menos una foto
 *   (`LISTING_NOT_READY`, 409);
 * - si ya hay una corrida activa, la devuelve (`reused`) y la **vuelve a encolar** (idempotente con
 *   `singletonKey`), así una corrida cuyo job se perdió (en cola, o en `running` tras un corte en el
 *   último intento) no bloquea el aviso;
 * - con `texts`, un texto vigente editado a mano da `CONTENT_EDITED` (409) salvo `replaceEdits`;
 * - si no, crea la corrida en `queued` y encola. Si otra petición ganó la carrera
 *   (`CONTENT_RUN_CONFLICT`), devuelve la activa;
 * - si la cola no está (`QUEUE_UNAVAILABLE`, 503), la corrida nueva queda en `failed` con ese motivo.
 */
export async function requestContentRun(
  deps: RequestContentRunDeps,
  { listingId, texts = true, replaceEdits = false }: RequestContentRunParams,
): Promise<RequestContentRunResult> {
  const listing = await deps.listings.get(listingId);
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
  const photos = (await deps.media.listOriginals(listingId)).filter((m) => m.kind === "image");
  if (photos.length === 0) {
    throw new AppError(
      "LISTING_NOT_READY",
      "El aviso no tiene fotos: agrégalas en la carpeta de medios y vuelve a importar",
      { details: { listingId, status: listing.status } },
    );
  }

  const active = await deps.contentRuns.findActive(listingId);
  if (active !== null) return reuse(deps, active);

  if (texts && !replaceEdits) {
    const edited = (await deps.contents.listCurrent(listingId)).filter(
      (content) => content.status === "edited",
    );
    if (edited.length > 0) {
      throw new AppError(
        "CONTENT_EDITED",
        "Hay textos editados a mano: prepara sin textos o confirma que quieres reemplazarlos",
        { details: { listingId, platforms: edited.map((content) => content.platform) } },
      );
    }
  }

  let run: ContentRun;
  try {
    run = await deps.contentRuns.create({ listingId, texts });
  } catch (error) {
    if (isAppError(error) && error.code === "CONTENT_RUN_CONFLICT") {
      const winner = await deps.contentRuns.findActive(listingId);
      if (winner !== null) return reuse(deps, winner);
    }
    throw error;
  }

  try {
    await enqueueContentRun(deps.queue, run.id);
  } catch (error) {
    if (isAppError(error) && error.code === "QUEUE_UNAVAILABLE") {
      // Si además falla la base, igual se informa el error de la cola: es la causa.
      await deps.contentRuns
        .markFailed(run.id, { code: error.code, message: error.message })
        .catch(() => false);
    }
    throw error;
  }
  return { run, reused: false };
}

/**
 * Devuelve la corrida activa y la vuelve a encolar por si su job se perdió: una en cola cuyo job no
 * existe, o una en `running` cuyo último intento se cortó al apagar el worker (spec F2 §4.4). Con
 * `singletonKey` en la cola `exclusive`, no duplica un job que siga en cola, en reintento o activo.
 */
async function reuse(
  deps: RequestContentRunDeps,
  run: ContentRun,
): Promise<RequestContentRunResult> {
  await enqueueContentRun(deps.queue, run.id);
  return { run, reused: true };
}
