import type { AbortSignalLike } from "../abort.js";
import type { Platform, PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publisher, PublishInput } from "../ports/publisher.js";
import type { Publication, PublicationError } from "../publication.js";
import { withDryRun } from "../publish/dry-run.js";
import {
  buildPublishInput,
  checkPublishInput,
  type PublishAttemptRecord,
  publishAttemptRecord,
} from "../publish/input.js";
import { redactText } from "../redact.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

export type PublishPublicationDeps = {
  publications: Pick<PublicationRepository, "get" | "transition" | "saveProgress" | "addEvent">;
  platformAccounts: Pick<PlatformAccountRepository, "get" | "getCredentials" | "changeStatus">;
  contents: Pick<ContentRepository, "get">;
  media: Pick<MediaRepository, "listByListing">;
  listings: Pick<ListingRepository, "changeStatus">;
  storage: Pick<MediaStorage, "signedReadUrl">;
  /** El publisher de cada plataforma que el worker sabe publicar. */
  publishers: Readonly<Partial<Record<Platform, Publisher>>>;
  /** El `PUBLISH_MODE` del worker: solo decide si una pedida en `live` se puede publicar (D11). */
  workerMode: PublishMode;
  /** Reloj, para `published_at`. */
  now?: () => Date;
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
  /** No estaba en `publishing` (ya terminó, se descartó o la tomó otro intento): no se hizo nada. */
  | { outcome: "skipped"; status: Publication["status"] };

/** Errores que no vienen de un adaptador: genéricos, sin detalles que puedan traer datos. */
function normalized(error: unknown): AppError {
  return isAppError(error)
    ? error
    : new AppError("INTERNAL_ERROR", "Error interno al publicar", { cause: error });
}

/**
 * El motivo legible que queda en `last_error` y en la bitácora: el mensaje del error (los de las
 * plataformas son fijos por código), sin rutas de R2 ni de disco y pasado por el redactor.
 */
const lastErrorOf = (error: AppError): PublicationError => ({
  code: error.code,
  message: redactText(error.message)
    .replace(/brokers\/\S+/g, "<archivo>")
    .replace(/(?:^|\s)\/[^\s/]+\/\S+/g, " <ruta>"),
  retriable: error.retriable,
});

/**
 * Un intento de publicación (el handler del job `publication.publish`, spec F3 §4.4 y ADR-0014):
 * 1. Recarga la publicación: si no está en `publishing`, no hace nada (`skipped`, idempotente).
 * 2. **El modo lo decide la publicación** (D11): `dry_run` se simula con `withDryRun` aunque el
 *    worker esté en `live`; una pedida en `live` con el worker en `dry-run` queda en `failed` con
 *    `PUBLISH_MODE_MISMATCH` (no reintentable), sin llamar a la plataforma.
 * 3. La cuenta tiene que estar `connected` (`ACCOUNT_NOT_CONNECTED`) y sus credenciales legibles
 *    (`CREDENTIALS_UNREADABLE`: la cuenta pasa a `error`). Se descifran también en `dry-run`.
 * 4. Arma el input (`buildPublishInput`: texto aprobado y medios fijos con URLs firmadas nuevas),
 *    lo revisa en `live` (`checkPublishInput`; en `dry-run` lo hace `withDryRun`) y publica, con el
 *    progreso guardado de intentos anteriores y `saveProgress`.
 * 5. Éxito: `published` con `external_id`, `external_url` y `published_at`. En `live`, después de
 *    guardar, el aviso pasa de `ready` a `active` (condicional; las de `dry-run` no lo cambian).
 * 6. Error: con la señal disparada (apagado del worker) no toca nada y relanza como reintentable.
 *    Si no, un reintentable antes del último intento deja la publicación en `publishing` y relanza
 *    (la cola reintenta y se retoma desde el progreso); uno no reintentable, o el último intento,
 *    la deja en `failed` con su motivo y relanza. `IG_AUTH_INVALID` pasa la cuenta a `expired`.
 * Cada intento que llega a la plataforma deja **un** evento `publish_attempt` con el modo, el
 * intento, el resultado y lo que se envió (`publishAttemptRecord`: sin URLs firmadas ni tokens).
 */
export async function publishPublication(
  deps: PublishPublicationDeps,
  { publicationId, isLastAttempt, retryCount = 0, signal }: PublishPublicationParams,
): Promise<PublishPublicationResult> {
  const publication = await deps.publications.get(publicationId);
  if (publication === null) throw publicationNotFound(publicationId);
  if (publication.status !== "publishing") {
    return { outcome: "skipped", status: publication.status };
  }
  const now = deps.now ?? (() => new Date());
  const mode = modeOf(publication.dryRun);
  const attempt = { mode, attempt: publication.attempts, retry: retryCount };
  let record: PublishAttemptRecord | null = null;

  try {
    if (!publication.dryRun && deps.workerMode === "dry-run") {
      throw new AppError(
        "PUBLISH_MODE_MISMATCH",
        "Se pidió publicar en vivo, pero el worker está en simulación: no se publicó nada",
      );
    }
    const publisher = deps.publishers[publication.platform];
    if (publisher === undefined) {
      throw new AppError(
        "PUBLISHER_NOT_CONFIGURED",
        "Esta plataforma todavía no se puede publicar",
        { details: { platform: publication.platform } },
      );
    }
    const account = await deps.platformAccounts.get(publication.platformAccountId);
    if (account === null || account.status !== "connected") {
      throw new AppError(
        "ACCOUNT_NOT_CONNECTED",
        "La cuenta de esta publicación no está conectada: reconéctala o descártala",
        { details: { accountStatus: account?.status ?? null } },
      );
    }
    let credentials: Awaited<ReturnType<typeof deps.platformAccounts.getCredentials>>;
    try {
      credentials = await deps.platformAccounts.getCredentials(account.id);
    } catch (error) {
      if (isAppError(error) && error.code === "CREDENTIALS_UNREADABLE") {
        await deps.platformAccounts
          .changeStatus(account.id, "connected", "error")
          .catch(() => false);
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
    record = publishAttemptRecord(input, account);
    const target = publication.dryRun ? withDryRun(publisher) : publisher;
    if (!publication.dryRun) checkPublishInput(publisher, input);
    const result = await target.publish(input, {
      account,
      credentials,
      progress: publication.progress,
      saveProgress: async (progress) => {
        await deps.publications.saveProgress(publicationId, progress);
      },
      ...(signal === undefined ? {} : { signal }),
    });

    await deps.publications.addEvent(publicationId, {
      type: "publish_attempt",
      actor: "system",
      payload: { ...attempt, result: "published", sent: record },
    });
    const published = await deps.publications.transition(
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
    // Después de guardar `published`: una retirada que se cruce deja el aviso bien (spec F3 §4.3).
    if (!publication.dryRun) {
      await deps.listings.changeStatus(publication.listingId, "ready", "active");
    }
    return { outcome: "published", publication: published };
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
        .catch(() => false);
    }
    const final = !error.retriable || isLastAttempt;
    await deps.publications
      .addEvent(publicationId, {
        type: "publish_attempt",
        actor: "system",
        payload: {
          ...attempt,
          result: final ? "failed" : "retry",
          error: lastErrorOf(error),
          ...(record === null ? {} : { sent: record }),
        },
      })
      .catch(() => undefined);
    if (final) {
      await deps.publications
        .transition(
          publicationId,
          { from: "publishing", to: "failed", changes: { lastError: lastErrorOf(error) } },
          { actor: "system", payload: { mode, code: error.code } },
        )
        .catch(() => undefined);
    }
    throw error;
  }
}
