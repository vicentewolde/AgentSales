import type { AbortSignalLike } from "../abort.js";
import type { PublicationStatus } from "../enums.js";
import { AppError } from "../errors.js";
import type { RemoteStatus } from "../ports/publisher.js";
import type { Publication, RemoteState } from "../publication.js";
import {
  failedCall,
  findPublication,
  listingBackToReadyIfLast,
  OPERATION_PLATFORMS,
  operationsOf,
  type PublicationPlatformDeps,
  platformContextFor,
  remoteStateFrom,
} from "./publication-operations.js";
import { publicationNotFound } from "./publication-start.js";

export type SyncPublicationDeps = PublicationPlatformDeps;

export type SyncPublicationResult =
  /** No hay nada que leer: otra plataforma, una simulación o una que no está en la plataforma. */
  | {
      outcome: "skipped";
      reason: "not_supported" | "dry_run" | "not_published";
      status: Publication["status"];
    }
  | {
      outcome: "synced";
      publication: Publication;
      /** El cambio de estado que aplicó, o `null` si solo guardó lo leído. */
      changed: { from: PublicationStatus; to: PublicationStatus } | null;
      /** Si la cerró y era la última en `live` del aviso, que volvió de `active` a `ready`. */
      listingBackToReady: boolean;
    };

/** Lo que Mercado Libre informa mientras procesa las fotos (la doc usa las dos grafías, nota §5). */
const PICTURES_PENDING = ["picture_download_pending", "picture_downloading_pending"];
/** Estados de la plataforma que dicen que el aviso ya no está (spec F4 §4.9). */
const GONE = new Set(["closed", "expired", "deleted"]);

/**
 * La tabla del sync (spec F4 §4.9): a qué estado pasa una publicación `published` o `paused` según
 * lo que informó Mercado Libre, o `null` si solo se guarda lo leído.
 * - `closed` (también `expired` o `deleted`) → `unpublished`;
 * - procesando fotos (`picture_download_pending`) → nada: el ítem nace así y se activa solo;
 * - `paused` desde `published` → `paused` (una pausa de Mercado Libre, con su motivo en
 *   `remote_state`);
 * - `active` desde `paused` → `published`;
 * - `under_review`, `not_yet_active` o uno desconocido (`inactive`, `payment_required`…) → nada:
 *   se guarda y se muestra.
 */
export function syncTarget(
  status: PublicationStatus,
  remote: Pick<RemoteState, "status" | "subStatus">,
): PublicationStatus | null {
  if (GONE.has(remote.status) || remote.subStatus.includes("deleted")) return "unpublished";
  if (remote.subStatus.some((sub) => PICTURES_PENDING.includes(sub))) return null;
  if (remote.status === "paused" && status === "published") return "paused";
  if (remote.status === "active" && status === "paused") return "published";
  return null;
}

/**
 * Sincroniza una publicación de Portal con lo que informa Mercado Libre (job `publication.sync`,
 * spec F4 §4.9). Solo actúa sobre una de Portal en `live` y `published` o `paused`; si no,
 * `skipped`. Es solo lectura en la plataforma, así que corre con la API y el worker en cualquier
 * modo:
 * 1. guarda el `updatedAt` de la publicación **antes** de leer (`getStatus`, fuera del candado);
 * 2. dentro del candado del aviso, si el `updatedAt` releído no es igual al guardado (la
 *    publicación cambió mientras se leía; por ejemplo, el operador la pausó), no aplica nada y
 *    lanza `PUBLICATION_SYNC_STALE` (reintentable: la cola la vuelve a leer). Se compara por
 *    igualdad entre dos valores de la base (`clock_timestamp()`), nunca contra el reloj del worker;
 * 3. guarda `remote_state` con un evento `sync` (lo leído, sin secretos) y, según `syncTarget`,
 *    cambia el estado con actor `system` (condicional desde el estado leído); al pasar a
 *    `unpublished`, el aviso vuelve a `ready` si era la última en `live`.
 * Errores: los de la plataforma (un `ML_AUTH_INVALID` deja la cuenta `expired`), la cuenta no
 * conectada (`ACCOUNT_NOT_CONNECTED`), un estado que no calza (`PUBLICATION_REMOTE_STATE_INVALID`) y
 * las operaciones no configuradas (`PUBLISHER_NOT_CONFIGURED`).
 */
export async function syncPublication(
  deps: SyncPublicationDeps,
  { publicationId, signal }: { publicationId: string; signal?: AbortSignalLike },
): Promise<SyncPublicationResult> {
  const found = await findPublication(deps, publicationId);
  if (!OPERATION_PLATFORMS.has(found.platform)) {
    return { outcome: "skipped", reason: "not_supported", status: found.status };
  }
  if (found.dryRun) return { outcome: "skipped", reason: "dry_run", status: found.status };
  if (found.status !== "published" && found.status !== "paused") {
    return { outcome: "skipped", reason: "not_published", status: found.status };
  }
  const externalId = found.externalId;
  if (externalId === null) {
    return { outcome: "skipped", reason: "not_published", status: found.status };
  }
  const readUpdatedAt = found.updatedAt.getTime();

  const operations = operationsOf(deps, found);
  const ctx = await platformContextFor(deps, found, signal);
  let reported: RemoteStatus;
  try {
    reported = await operations.getStatus({ externalId, progress: found.progress }, ctx);
  } catch (error) {
    return failedCall(deps, found, error);
  }
  const remote = remoteStateFrom(deps, publicationId, reported);
  if (remote === undefined) {
    throw new AppError(
      "PUBLICATION_REMOTE_STATE_INVALID",
      "El estado informado por la plataforma no es válido",
      { details: { publicationId } },
    );
  }

  return deps.lock.run(found.listingId, async (locked) => {
    const current = await locked.publications.get(publicationId);
    if (current === null) throw publicationNotFound(publicationId);
    if (current.updatedAt.getTime() !== readUpdatedAt) {
      throw new AppError(
        "PUBLICATION_SYNC_STALE",
        "La publicación cambió mientras se leía su estado en la plataforma: se vuelve a leer",
        { retriable: true, details: { publicationId } },
      );
    }
    let publication = await locked.publications.setRemoteState(publicationId, remote, {
      type: "sync",
      actor: "system",
      payload: { remote },
    });
    const target = syncTarget(current.status, remote);
    if (target === null) {
      return { outcome: "synced", publication, changed: null, listingBackToReady: false };
    }
    publication = await locked.publications.transition(
      publicationId,
      { from: current.status, to: target },
      { actor: "system", payload: { mode: "live", sync: true, remoteStatus: remote.status } },
    );
    const listingBackToReady =
      target === "unpublished" ? await listingBackToReadyIfLast(locked, found.listingId) : false;
    return {
      outcome: "synced",
      publication,
      changed: { from: current.status, to: target },
      listingBackToReady,
    };
  });
}
