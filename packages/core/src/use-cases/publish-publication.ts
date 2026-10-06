import type { AbortSignalLike } from "../abort.js";
import type { Platform, PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publisher, PublishInput, PublishResult } from "../ports/publisher.js";
import {
  type Publication,
  type PublicationError,
  type PublishAttemptPayload,
  type PublishAttemptRecord,
  type PublishAttemptResult,
  publishAttemptPayloadSchema,
} from "../publication.js";
import { withDryRun } from "../publish/dry-run.js";
import { buildPublishInput, checkPublishInput, publishAttemptRecord } from "../publish/input.js";
import { scrubMessage } from "../redact.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

/**
 * Un paso secundario que falló sin cortar el intento (la bitácora, el estado de la cuenta o del
 * aviso): el worker lo registra, solo con el id y el código.
 */
export type PublishWarning = {
  publicationId: string;
  step: "attempt_event" | "mark_failed" | "listing_active" | "account_status";
  code: string;
};

export type PublishPublicationDeps = {
  publications: Pick<PublicationRepository, "get" | "transition" | "saveProgress" | "addEvent">;
  platformAccounts: Pick<PlatformAccountRepository, "get" | "getCredentials" | "changeStatus">;
  contents: Pick<ContentRepository, "get">;
  media: Pick<MediaRepository, "listByListing">;
  listings: Pick<ListingRepository, "changeStatus">;
  storage: Pick<MediaStorage, "signedReadUrl">;
  /**
   * El publisher de cada plataforma que el worker sabe publicar. Va en los dos modos: una
   * publicación en `dry_run` también lo necesita (lo envuelve `withDryRun`, que no lo llama).
   */
  publishers: Readonly<Partial<Record<Platform, Publisher>>>;
  /** El `PUBLISH_MODE` del worker: solo decide si una pedida en `live` se puede publicar (D11). */
  workerMode: PublishMode;
  /** Reloj, para `published_at`. */
  now?: () => Date;
  onWarning?: (warning: PublishWarning) => void;
};

export type PublishPublicationParams = {
  publicationId: string;
  /** Último intento del job: un error reintentable deja la publicación en `failed`. */
  isLastAttempt: boolean;
  /** Reintento de la cola (0 en el primero), para la bitácora. */
  retryCount?: number;
  /** El del worker: se dispara al apagarse. */
  signal?: AbortSignalLike;
};

export type PublishPublicationResult =
  | { outcome: "published"; publication: Publication }
  /** No estaba en `publishing` (ya terminó, se descartó o la tomó otro intento): no se publicó. */
  | { outcome: "skipped"; status: Publication["status"] };

/** Errores que no vienen de un adaptador: genéricos (no reintentables), sin su mensaje. */
function normalized(error: unknown): AppError {
  return isAppError(error)
    ? error
    : new AppError("INTERNAL_ERROR", "Error interno al publicar", { cause: error });
}

/** El motivo que ven el operador y la bitácora: sin secretos, claves de R2 ni rutas. */
const lastErrorOf = (error: AppError): PublicationError => ({
  code: error.code,
  message: scrubMessage(error.message),
  retriable: error.retriable,
});

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Un intento de publicación (el handler del job `publication.publish`, spec F3 §4.4 y ADR-0014):
 * 1. Recarga la publicación: si no está en `publishing`, no publica (`skipped`, idempotente). Si
 *    está `published` en `live`, vuelve a intentar subir el aviso a `active` (un intento anterior
 *    pudo no alcanzar).
 * 2. **El modo lo decide la publicación** (D11): `dry_run` se simula con `withDryRun` aunque el
 *    worker esté en `live`; una pedida en `live` con el worker en `dry-run` queda en `failed` con
 *    `PUBLISH_MODE_MISMATCH` (no reintentable), sin llamar a la plataforma.
 * 3. La cuenta tiene que estar `connected` (`ACCOUNT_NOT_CONNECTED`) y sus credenciales legibles
 *    (`CREDENTIALS_UNREADABLE`: la cuenta pasa a `error`). Se descifran también en `dry-run`.
 * 4. Arma el input (`buildPublishInput`), lo revisa en `live` (`checkPublishInput`; en `dry-run` lo
 *    hace `withDryRun`) y publica con el progreso guardado y `saveProgress`.
 * 5. Guarda `published` (`external_id`, `external_url`, `published_at`). Si **eso** falla, el medio
 *    ya salió: la publicación sigue en `publishing` y se relanza `PUBLISH_RESULT_NOT_SAVED`
 *    (reintentable): el reintento lo reconoce por el progreso y lo guarda, sin publicar de nuevo.
 * 6. Después, sin cortar: el evento `publish_attempt` y, en `live`, el aviso de `ready` a `active`.
 * 7. Error antes de publicar: con la señal disparada (apagado del worker) no toca nada y relanza como
 *    reintentable. Si no, uno reintentable antes del último intento deja la publicación en
 *    `publishing` y relanza (la cola reintenta); uno no reintentable, o el último intento, la deja
 *    en `failed` con su motivo y relanza. `IG_AUTH_INVALID` pasa la cuenta a `expired`. Un error que
 *    no es `AppError` es `INTERNAL_ERROR` (no reintentable).
 * Cada intento deja **un** evento `publish_attempt` (`publishAttemptPayloadSchema`), salvo un corte
 * por apagado. Los pasos secundarios que fallan van a `onWarning`.
 * Para el worker: un error no reintentable ya dejó la publicación en `failed` (registrar el código y
 * cerrar el job); uno reintentable se relanza para que la cola reintente.
 */
export async function publishPublication(
  deps: PublishPublicationDeps,
  { publicationId, isLastAttempt, retryCount = 0, signal }: PublishPublicationParams,
): Promise<PublishPublicationResult> {
  const publication = await deps.publications.get(publicationId);
  if (publication === null) throw publicationNotFound(publicationId);
  const warn = (step: PublishWarning["step"], error: unknown) =>
    deps.onWarning?.({ publicationId, step, code: codeOf(error) });
  const listingToActive = async () => {
    if (publication.dryRun) return;
    await deps.listings
      .changeStatus(publication.listingId, "ready", "active")
      .catch((error: unknown) => warn("listing_active", error));
  };
  if (publication.status !== "publishing") {
    if (publication.status === "published") await listingToActive();
    return { outcome: "skipped", status: publication.status };
  }

  const now = deps.now ?? (() => new Date());
  const mode = modeOf(publication.dryRun);
  const addAttempt = async (
    result: PublishAttemptResult,
    extra: { error?: PublicationError; sent?: PublishAttemptRecord | null },
  ) => {
    const payload: PublishAttemptPayload = publishAttemptPayloadSchema.parse({
      mode,
      attempt: publication.attempts,
      retry: retryCount,
      result,
      ...(extra.error === undefined ? {} : { error: extra.error }),
      ...(extra.sent == null ? {} : { sent: extra.sent }),
    });
    await deps.publications
      .addEvent(publicationId, { type: "publish_attempt", actor: "system", payload })
      .catch((error: unknown) => warn("attempt_event", error));
  };

  let sent: PublishAttemptRecord | null = null;
  let result: PublishResult;
  try {
    const attempt = await prepareAttempt(deps, publication);
    sent = attempt.sent;
    result = await attempt.target.publish(attempt.input, {
      account: attempt.account,
      credentials: attempt.credentials,
      progress: publication.progress,
      saveProgress: async (progress) => {
        await deps.publications.saveProgress(publicationId, progress);
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (caught) {
    const error = normalized(caught);
    // Apagado del worker: la publicación queda en `publishing` y el reintento la retoma.
    if (signal?.aborted) {
      throw error.retriable
        ? error
        : new AppError("PUBLISH_ABORTED", "Se cortó la publicación", {
            retriable: true,
            cause: error,
          });
    }
    if (error.code === "IG_AUTH_INVALID") {
      await deps.platformAccounts
        .changeStatus(publication.platformAccountId, "connected", "expired")
        .catch((failure: unknown) => warn("account_status", failure));
    }
    const final = !error.retriable || isLastAttempt;
    await addAttempt(final ? "failed" : "retry", { error: lastErrorOf(error), sent });
    if (final) {
      try {
        await deps.publications.transition(
          publicationId,
          { from: "publishing", to: "failed", changes: { lastError: lastErrorOf(error) } },
          { actor: "system", payload: { mode, code: error.code } },
        );
      } catch (failure) {
        warn("mark_failed", failure);
        // Si la base no respondió, que la cola reintente: el intento retoma desde el progreso.
        if (isAppError(failure) && failure.retriable) throw failure;
      }
    }
    throw error;
  }

  // El medio ya salió: de aquí en adelante, nada lo trata como un fallo de publicación.
  let published: Publication;
  try {
    published = await deps.publications.transition(
      publicationId,
      {
        from: "publishing",
        to: "published",
        changes: {
          externalId: result.externalId,
          externalUrl: result.externalUrl,
          publishedAt: now(),
          lastError: null,
        },
      },
      { actor: "system", payload: { mode } },
    );
  } catch (failure) {
    throw new AppError(
      "PUBLISH_RESULT_NOT_SAVED",
      "Se publicó, pero no se pudo guardar el resultado: se reintenta sin publicar de nuevo",
      { retriable: true, cause: failure, details: { publicationId } },
    );
  }
  await addAttempt("published", { sent });
  // Después de guardar `published`: una retirada que se cruce deja el aviso bien (spec F3 §4.3).
  await listingToActive();
  return { outcome: "published", publication: published };
}

/** Todo lo que se revisa y arma antes de llamar a la plataforma. */
async function prepareAttempt(deps: PublishPublicationDeps, publication: Publication) {
  if (!publication.dryRun && deps.workerMode === "dry-run") {
    throw new AppError(
      "PUBLISH_MODE_MISMATCH",
      "Se pidió publicar en vivo, pero el worker está en simulación: no se publicó nada",
    );
  }
  const publisher = deps.publishers[publication.platform];
  if (publisher === undefined) {
    throw new AppError("PUBLISHER_NOT_CONFIGURED", "Esta plataforma todavía no se puede publicar", {
      details: { platform: publication.platform },
    });
  }
  const account = await deps.platformAccounts.get(publication.platformAccountId);
  if (account === null || account.status !== "connected") {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de esta publicación no está conectada: reconéctala o descártala",
      { details: { accountStatus: account?.status ?? null } },
    );
  }
  let credentials: Awaited<
    ReturnType<PublishPublicationDeps["platformAccounts"]["getCredentials"]>
  >;
  try {
    credentials = await deps.platformAccounts.getCredentials(account.id);
  } catch (error) {
    if (isAppError(error) && error.code === "CREDENTIALS_UNREADABLE") {
      await deps.platformAccounts
        .changeStatus(account.id, "connected", "error")
        .catch((failure: unknown) =>
          deps.onWarning?.({
            publicationId: publication.id,
            step: "account_status",
            code: codeOf(failure),
          }),
        );
    }
    throw error;
  }
  const content = await deps.contents.get(publication.contentId);
  if (content === null) {
    throw new AppError("CONTENT_NOT_FOUND", "No existe el texto de esta publicación", {
      details: { contentId: publication.contentId },
    });
  }
  const input: PublishInput = await buildPublishInput(deps, {
    publication,
    content,
    media: await deps.media.listByListing(publication.listingId),
  });
  if (!publication.dryRun) checkPublishInput(publisher, input);
  return {
    input,
    account,
    credentials,
    sent: publishAttemptRecord(input, account),
    target: publication.dryRun ? withDryRun(publisher) : publisher,
  };
}
