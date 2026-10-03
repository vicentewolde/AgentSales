import type { ContentRun } from "../content.js";
import type { ListingStatus } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
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

/** Estados en que un aviso puede preparar contenido (spec F2 §4.4). */
const PREPARABLE: readonly ListingStatus[] = ["ready", "paused", "active"];

const enqueue = (queue: JobQueue, run: ContentRun) =>
  queue.enqueue("content.prepare", { contentRunId: run.id }, { singletonKey: run.id });

/**
 * Pide una corrida de contenido (spec F2 §4.4):
 * - el aviso debe estar en `ready`, `paused` o `active` y tener al menos una foto
 *   (`LISTING_NOT_READY`, 409);
 * - si ya hay una corrida activa, la devuelve (`reused`); si está en `queued`, la **vuelve a
 *   encolar** (idempotente con `singletonKey`), así una corrida cuyo job se perdió no bloquea el aviso;
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
  if (!PREPARABLE.includes(listing.status)) {
    throw new AppError(
      "LISTING_NOT_READY",
      "El aviso tiene que estar listo, pausado o publicado para preparar su contenido",
      { details: { listingId, status: listing.status } },
    );
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
    await enqueue(deps.queue, run);
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

/** Devuelve la corrida activa; si sigue en cola, la vuelve a encolar por si su job se perdió. */
async function reuse(
  deps: RequestContentRunDeps,
  run: ContentRun,
): Promise<RequestContentRunResult> {
  if (run.status === "queued") await enqueue(deps.queue, run);
  return { run, reused: true };
}
