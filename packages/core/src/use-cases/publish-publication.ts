import type { AbortSignalLike } from "../abort.js";
import type { Platform, PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import {
  type AccessTokenProvider,
  type Publisher,
  type PublishInput,
  type PublishResult,
  storedAccessToken,
} from "../ports/publisher.js";

/** Advertencias de un intento que van a la bitácora, como mucho (las causas de Mercado Libre, 20). */
const MAX_ATTEMPT_NOTES = 20;

import {
  type Publication,
  type PublicationError,
  type PublishAttemptPayload,
  type PublishAttemptRecord,
  type PublishAttemptResult,
  publishAttemptPayloadSchema,
  type RemoteState,
  remoteStateSchema,
} from "../publication.js";
import { withDryRun } from "../publish/dry-run.js";
import { buildPublishInput, checkPublishInput, publishAttemptRecord } from "../publish/input.js";
import { scrubMessage } from "../redact.js";
import { accessTokenProvider } from "./ensure-access-token.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

/**
 * Un paso secundario que falló sin cortar el intento (la bitácora, el estado de la cuenta o del
 * aviso): el worker lo registra, solo con el id y el código.
 */
export type PublishWarning = {
  publicationId: string;
  step: "attempt_event" | "mark_failed" | "listing_active" | "account_status" | "remote_state";
  code: string;
};

export type PublishPublicationDeps = {
  publications: Pick<PublicationRepository, "get" | "transition" | "saveProgress" | "addEvent">;
  /** `withCredentialsLock`: el refresco del token de Mercado Libre (`ensureAccessToken`, Portal). */
  platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "getCredentials" | "changeStatus" | "withCredentialsLock"
  >;
  /**
   * El refresco de Mercado Libre para el token de Portal (`ensureAccessToken`, fuera del candado
   * del aviso), o `null` si falta el par de la app: entonces un token por vencer es
   * `MERCADOLIBRE_NOT_CONFIGURED` (no reintentable).
   */
  mercadoLibre: Pick<MercadoLibreAuth, "refresh"> | null;
  contents: Pick<ContentRepository, "get">;
  media: Pick<MediaRepository, "listByListing">;
  /** `get` y `getSourceHash`: el aviso de Portal y Marketplace en el input (spec F4 §4.6). */
  listings: Pick<ListingRepository, "changeStatus" | "get" | "getSourceHash">;
  /** El contacto del corredor en el input de Portal y Marketplace. */
  brokers: Pick<BrokerRepository, "findById">;
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
 *    hace `withDryRun`) y publica con el progreso guardado y `saveProgress`. El token: en
 *    Instagram, el guardado (`storedAccessToken`); en Portal, `accessTokenProvider`
 *    (`ensureAccessToken`, que lo refresca si vence y después de un 401), nunca el guardado tal
 *    cual, y las credenciales del contexto van sin el `refreshToken` (es de un solo uso y queda
 *    viejo después de refrescar).
 * 5. Guarda `published` (`external_id`, `external_url`, `published_at` y, si la plataforma lo
 *    informó, `remote_state` con `checkedAt`; uno que no calza con `remoteStateSchema` se avisa y
 *    no se guarda: no debe dejar la publicación repitiendo el paso 5). Si **eso** falla, el medio
 *    ya salió: la publicación sigue en `publishing` y se relanza `PUBLISH_RESULT_NOT_SAVED`
 *    (reintentable): el reintento lo reconoce por el progreso y lo guarda, sin publicar de nuevo.
 * 6. Después, sin cortar: el evento `publish_attempt` y, en `live`, el aviso de `ready` a `active`.
 * 7. Error antes de publicar: con la señal disparada (apagado del worker) no toca nada y relanza como
 *    reintentable. Si no, uno reintentable antes del último intento deja la publicación en
 *    `publishing` y relanza (la cola reintenta); uno no reintentable, o el último intento, la deja
 *    en `failed` con su motivo y relanza. `IG_AUTH_INVALID` y `ML_AUTH_INVALID` (también el 401
 *    repetido, `rejected_after_refresh`, del catálogo o del publisher) pasan la cuenta a
 *    `expired`. Un error que
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
    extra: { error?: PublicationError; sent?: PublishAttemptRecord | null; notes?: string[] },
  ) => {
    const payload: PublishAttemptPayload = publishAttemptPayloadSchema.parse({
      mode,
      attempt: publication.attempts,
      retry: retryCount,
      result,
      ...(extra.error === undefined ? {} : { error: extra.error }),
      ...(extra.sent == null ? {} : { sent: extra.sent }),
      // Las advertencias, limpias (sin secretos, claves de R2 ni rutas) y como mucho 20.
      ...(extra.notes === undefined || extra.notes.length === 0
        ? {}
        : { notes: extra.notes.slice(0, MAX_ATTEMPT_NOTES).map(scrubMessage) }),
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
      accessToken: attempt.accessToken,
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
    if (error.code === "IG_AUTH_INVALID" || error.code === "ML_AUTH_INVALID") {
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
  const remoteState = remoteStateOf(result, now(), (error) => warn("remote_state", error));
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
          ...(remoteState === undefined ? {} : { remoteState }),
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
  await addAttempt("published", {
    sent,
    ...(result.notes === undefined ? {} : { notes: result.notes }),
  });
  // Después de guardar `published`: una retirada que se cruce deja el aviso bien (spec F3 §4.3).
  await listingToActive();
  return { outcome: "published", publication: published };
}

/**
 * Lo que informó la plataforma al publicar (`PublishResult.remote`), con `checkedAt`, listo para
 * guardar; `undefined` si no informó nada o si no calza con `remoteStateSchema` (se avisa).
 */
function remoteStateOf(
  result: PublishResult,
  checkedAt: Date,
  onInvalid: (error: AppError) => void,
): RemoteState | undefined {
  if (result.remote === undefined) return undefined;
  const parsed = remoteStateSchema.safeParse({
    ...result.remote,
    checkedAt: checkedAt.toISOString(),
  });
  if (parsed.success) return parsed.data;
  onInvalid(
    new AppError(
      "PUBLICATION_REMOTE_STATE_INVALID",
      "El estado informado por la plataforma no es válido",
    ),
  );
  return undefined;
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
  let stored: Awaited<ReturnType<PublishPublicationDeps["platformAccounts"]["getCredentials"]>>;
  try {
    stored = await deps.platformAccounts.getCredentials(account.id);
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
  // Portal: el token lo asegura `ensureAccessToken` (fuera del candado del aviso), y el contexto no
  // lleva el `refreshToken`. `credentials.accessToken` puede estar vencido o ya rotado: el
  // publisher de Portal usa siempre `ctx.accessToken` (`platformContextOf` solo cae en él sin
  // proveedor). Instagram: el guardado, que falla cerrado ante `rejectedToken`.
  const portal = publication.platform === "portal_inmobiliario";
  const credentials = portal ? { accessToken: stored.accessToken } : stored;
  const accessToken: AccessTokenProvider = portal
    ? accessTokenProvider(
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
      )
    : storedAccessToken(stored);
  return {
    input,
    account,
    credentials,
    accessToken,
    sent: publishAttemptRecord(input, account),
    target: publication.dryRun ? withDryRun(publisher) : publisher,
  };
}
