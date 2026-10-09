import type { AbortSignalLike } from "../abort.js";
import type { Platform, PublicationStatus, PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { PlatformAccount } from "../platform-account.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock, LockedRepositories } from "../ports/listing-lock.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { PlatformContext, Publisher, RemoteStatus } from "../ports/publisher.js";
import {
  type Publication,
  type PublicationActor,
  type RemoteState,
  remoteStateSchema,
} from "../publication.js";
import { accessTokenProvider } from "./ensure-access-token.js";
import { expireAccountIfRejected } from "./platform-auth.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

// Piezas comunes de pausar, reactivar, cerrar y sincronizar (spec F4 §4.9, ADR-0015).

/**
 * Lo que una plataforma sabe hacer sobre lo publicado: lo implementa el publisher de Portal y lo
 * compone la API sin las fotos ni el catálogo (`createPortalOperations`, F4-T15).
 */
export type PublicationOperations = Pick<Publisher, "pause" | "resume" | "close" | "getStatus">;

/**
 * Las plataformas cuyas publicaciones se pausan, reactivan, cierran y sincronizan desde AgentSales.
 * Instagram no: se retira a mano (F3, D8).
 */
export const OPERATION_PLATFORMS: ReadonlySet<Platform> = new Set(["portal_inmobiliario"]);

/** Lo que el operador pide sobre una publicación ya publicada. */
export type PublicationOperation = "pause" | "resume" | "close";

/** Algo secundario que falló sin cortar (el estado de la cuenta o del aviso, el sync, el estado remoto). */
export type OperationWarning = {
  publicationId: string;
  step: "account_status" | "enqueue_sync" | "remote_state";
  code: string;
};

/** Lo común de las operaciones y el sync. */
export type PublicationPlatformDeps = {
  lock: ListingLock;
  /** Fuera del candado solo se lee la publicación (para saber su aviso y su estado). */
  publications: Pick<PublicationRepository, "get">;
  /** El token de Portal (`ensureAccessToken`, fuera del candado del aviso). */
  platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "getCredentials" | "changeStatus" | "withCredentialsLock"
  >;
  /** El refresco de Mercado Libre, o `null` sin el par de la app. */
  mercadoLibre: Pick<MercadoLibreAuth, "refresh"> | null;
  /**
   * Las operaciones de una plataforma (sin envolver en `withDryRun`, que no las expone). Se pide
   * **después** de decidir el modo con `publication.dryRun`: en `dry-run` no se llama.
   */
  operationsFor(platform: Platform): PublicationOperations | undefined;
  now?: () => Date;
  onWarning?: (warning: OperationWarning) => void;
};

export const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/** La publicación, leída fuera del candado, o `PUBLICATION_NOT_FOUND`. */
export async function findPublication(
  deps: Pick<PublicationPlatformDeps, "publications">,
  publicationId: string,
): Promise<Publication> {
  const publication = await deps.publications.get(publicationId);
  if (publication === null) throw publicationNotFound(publicationId);
  return publication;
}

/** Una publicación de una plataforma que no se opera desde AgentSales (Instagram). */
export function requireOperationPlatform(publication: Publication): void {
  if (!OPERATION_PLATFORMS.has(publication.platform)) {
    throw new AppError(
      "OPERATION_NOT_SUPPORTED",
      "Esta plataforma no se pausa, reactiva ni cierra desde AgentSales: márcala como retirada",
      { details: { publicationId: publication.id, platform: publication.platform } },
    );
  }
}

/** Las operaciones de la plataforma de la publicación, o `PUBLISHER_NOT_CONFIGURED`. */
export function operationsOf(
  deps: Pick<PublicationPlatformDeps, "operationsFor">,
  publication: Publication,
): Required<PublicationOperations> {
  const operations = deps.operationsFor(publication.platform);
  const { pause, resume, close, getStatus } = operations ?? {};
  if (
    operations === undefined ||
    pause === undefined ||
    resume === undefined ||
    close === undefined ||
    getStatus === undefined
  ) {
    throw new AppError(
      "PUBLISHER_NOT_CONFIGURED",
      "Esta plataforma todavía no se puede operar desde aquí",
      { details: { platform: publication.platform } },
    );
  }
  return {
    pause: pause.bind(operations),
    resume: resume.bind(operations),
    close: close.bind(operations),
    getStatus: getStatus.bind(operations),
  };
}

/**
 * El contexto de una llamada a la plataforma (fuera del candado): la cuenta conectada
 * (`ACCOUNT_NOT_CONNECTED` si no) y el proveedor de token de Portal (`accessTokenProvider`).
 */
export async function platformContextFor(
  deps: PublicationPlatformDeps,
  publication: Publication,
  signal?: AbortSignalLike,
): Promise<PlatformContext> {
  const account: PlatformAccount | null = await deps.platformAccounts.get(
    publication.platformAccountId,
  );
  if (account === null || account.status !== "connected") {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de esta publicación no está conectada: reconéctala",
      { details: { publicationId: publication.id, accountStatus: account?.status ?? null } },
    );
  }
  return {
    account,
    accessToken: accessTokenProvider(
      {
        platformAccounts: deps.platformAccounts,
        mercadoLibre: deps.mercadoLibre,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        onWarning: (warning) =>
          deps.onWarning?.({
            publicationId: publication.id,
            step: "account_status",
            code: warning.code,
          }),
      },
      account.id,
    ),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Un error de la plataforma: si rechazó el acceso, la cuenta queda `expired` (spec F4 §4.3). Se
 * relanza siempre.
 */
export async function failedCall(
  deps: PublicationPlatformDeps,
  publication: Publication,
  error: unknown,
): Promise<never> {
  await expireAccountIfRejected(
    deps.platformAccounts,
    publication.platformAccountId,
    error,
    (failure) =>
      deps.onWarning?.({
        publicationId: publication.id,
        step: "account_status",
        code: codeOf(failure),
      }),
  );
  throw error;
}

/**
 * Lo que informó la plataforma, con `checkedAt`, listo para guardar; `undefined` si no calza con
 * `remoteStateSchema` (se avisa: no debe impedir guardar el cambio de estado).
 */
export function remoteStateFrom(
  deps: Pick<PublicationPlatformDeps, "now" | "onWarning">,
  publicationId: string,
  remote: RemoteStatus,
): RemoteState | undefined {
  const now = deps.now ?? (() => new Date());
  const parsed = remoteStateSchema.safeParse({ ...remote, checkedAt: now().toISOString() });
  if (parsed.success) return parsed.data;
  deps.onWarning?.({
    publicationId,
    step: "remote_state",
    code: "PUBLICATION_REMOTE_STATE_INVALID",
  });
  return undefined;
}

/**
 * Encola `publication.sync` (idempotente por publicación) para que el estado converja: después de
 * una respuesta perdida o de un guardado que falló. No corta: un fallo de la cola va a `onWarning`
 * (el sync al arrancar el worker o el botón Actualizar lo cubren).
 */
export async function requestSync(
  deps: Pick<PublicationPlatformDeps, "onWarning"> & { queue: JobQueue },
  publicationId: string,
): Promise<void> {
  await deps.queue
    .enqueue("publication.sync", { publicationId }, { singletonKey: publicationId })
    .catch((failure: unknown) =>
      deps.onWarning?.({ publicationId, step: "enqueue_sync", code: codeOf(failure) }),
    );
}

/**
 * Después de bajar una publicación en `live` (cerrar, o un sync que la vio cerrada): si era la
 * última publicada o pausada en `live` del aviso, el aviso vuelve de `active` a `ready` (cambio del
 * sistema, condicional: si el aviso ya cambió, no se toca). Como al retirar (F3).
 */
export async function listingBackToReadyIfLast(
  locked: Pick<LockedRepositories, "publications" | "listings">,
  listingId: string,
): Promise<boolean> {
  // Una que se está publicando en `live` no cuenta: si sale, el intento sube el aviso a `active`.
  const stillLive = (await locked.publications.listByListing(listingId)).some(
    (other) => !other.dryRun && (other.status === "published" || other.status === "paused"),
  );
  if (stillLive) return false;
  return locked.listings.changeStatus(listingId, "active", "ready");
}

/** El modo que pide la API para las operaciones (D11 de F3): lo usan pausar, reactivar y cerrar. */
export type OperationModeDeps = {
  /** El `PUBLISH_MODE` de la API: una publicación de `live` exige la API en `live`. */
  apiMode: PublishMode;
  queue: JobQueue;
};

/** De dónde sale cada operación, a dónde llega y cómo se llama en la bitácora. */
export const OPERATION_MOVES: Readonly<
  Record<PublicationOperation, { from: readonly PublicationStatus[]; to: PublicationStatus }>
> = {
  pause: { from: ["published"], to: "paused" },
  resume: { from: ["paused"], to: "published" },
  close: { from: ["published", "paused"], to: "unpublished" },
};

export type OperatedPublication = {
  publication: Publication;
  /** Solo al cerrar en `live`: si era la última y el aviso volvió de `active` a `ready`. */
  listingBackToReady: boolean;
};

/**
 * Pausar, reactivar o cerrar una publicación (spec F4 §4.9, ADR-0015; síncronos en la API):
 * 1. Lee la publicación fuera del candado y revisa: que su plataforma se opere desde AgentSales
 *    (`OPERATION_NOT_SUPPORTED`; Instagram se retira) y que el estado lo permita
 *    (`INVALID_TRANSITION`).
 * 2. **El modo lo decide `publication.dryRun`**, antes de elegir las operaciones: una de `dry-run`
 *    se cambia en simulación, sin llamar a la plataforma; una de `live` exige la API en `live`
 *    (`PUBLISH_MODE_MISMATCH`: nunca se cambia algo real estando en simulación) y, al cerrar, la
 *    confirmación (`CLOSE_NOT_CONFIRMED`: es irreversible).
 * 3. En `live`, llama a la plataforma **antes y fuera** del `ListingLock` (con su token). Un
 *    `ML_AUTH_INVALID` deja la cuenta `expired`; un `ML_UNAVAILABLE` o `ML_ABORTED` (la respuesta
 *    pudo perderse con el cambio aplicado) encola un sync. El error se relanza.
 * 4. Dentro del candado, aplica la transición **condicional** desde el estado leído, con su evento
 *    (`mode`, `operation` y lo que informó la plataforma) y el `remote_state`. Si eso falla, se
 *    encola un sync (Mercado Libre ya cambió) y el error se relanza. Al cerrar en `live` la última
 *    publicada o pausada del aviso, este vuelve a `ready`.
 */
export async function operatePublication(
  deps: PublicationPlatformDeps & OperationModeDeps,
  {
    publicationId,
    operation,
    actor,
    confirmed = false,
    signal,
  }: {
    publicationId: string;
    operation: PublicationOperation;
    actor: PublicationActor;
    /** Solo cerrar en `live`: el operador confirmó (es irreversible). */
    confirmed?: boolean;
    signal?: AbortSignalLike;
  },
): Promise<OperatedPublication> {
  const found = await findPublication(deps, publicationId);
  requireOperationPlatform(found);
  const move = OPERATION_MOVES[operation];
  if (!move.from.includes(found.status)) {
    throw new AppError("INVALID_TRANSITION", OPERATION_NOT_ALLOWED_TEXT[operation], {
      details: { publicationId, from: found.status, to: move.to },
    });
  }
  const live = !found.dryRun;
  let remote: RemoteState | undefined;
  if (live) {
    if (deps.apiMode !== "live") {
      throw new AppError(
        "PUBLISH_MODE_MISMATCH",
        "Esta publicación está en vivo, pero AgentSales está en simulación: no se cambió nada en la plataforma",
        { details: { publicationId } },
      );
    }
    if (operation === "close" && !confirmed) {
      throw new AppError(
        "CLOSE_NOT_CONFIRMED",
        "Cerrar es definitivo (volver a publicar crea otro aviso y gasta otro cupo): confirma que quieres cerrarla",
        { details: { publicationId } },
      );
    }
    const operations = operationsOf(deps, found);
    const ctx = await platformContextFor(deps, found, signal);
    let reported: RemoteStatus;
    try {
      if (found.externalId === null) {
        throw new AppError(
          "PUBLICATION_NOT_PUBLISHED",
          "La publicación no tiene id en la plataforma",
          {
            details: { publicationId },
          },
        );
      }
      reported = await operations[operation](
        { externalId: found.externalId, progress: found.progress },
        ctx,
      );
    } catch (error) {
      if (isAppError(error) && LOST_RESPONSE_CODES.has(error.code)) {
        await requestSync(deps, publicationId);
      }
      return failedCall(deps, found, error);
    }
    remote = remoteStateFrom(deps, publicationId, reported);
  }

  try {
    return await deps.lock.run(found.listingId, async (locked) => {
      const publication = await locked.publications.transition(
        publicationId,
        {
          from: found.status,
          to: move.to,
          ...(remote === undefined ? {} : { changes: { remoteState: remote } }),
        },
        {
          actor,
          payload: {
            mode: modeOf(found.dryRun),
            operation,
            ...(remote === undefined ? {} : { remote }),
          },
        },
      );
      // Un error de la base dentro del candado no se recupera: deshace todo y el sync lo corrige.
      const listingBackToReady =
        live && operation === "close"
          ? await listingBackToReadyIfLast(locked, found.listingId)
          : false;
      return { publication, listingBackToReady };
    });
  } catch (error) {
    // La plataforma ya cambió: el sync deja la publicación como está allá.
    if (live) await requestSync(deps, publicationId);
    throw error;
  }
}

/** Errores después de los cuales la plataforma pudo aplicar el cambio sin que llegara la respuesta. */
const LOST_RESPONSE_CODES = new Set(["ML_UNAVAILABLE", "ML_ABORTED"]);

const OPERATION_NOT_ALLOWED_TEXT: Readonly<Record<PublicationOperation, string>> = {
  pause: "Solo se pausa una publicación publicada",
  resume: "Solo se reactiva una publicación pausada",
  close: "Solo se cierra una publicación publicada o pausada",
};
