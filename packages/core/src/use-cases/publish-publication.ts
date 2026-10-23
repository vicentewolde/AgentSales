import type { AbortSignalLike } from "../abort.js";
import { chileMonthOf, chileMonthRange } from "../chile-time.js";
import type { Platform, PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { assertMarketplaceAutomationAllowed } from "../marketplace/automation.js";
import {
  DEFAULT_MARKETPLACE_DAILY_LIMIT,
  MARKETPLACE_TIME_ZONE,
  marketplaceDailyLimitReached,
  marketplaceFormOpen,
  requiresManualConfirm,
  startOfDayIn,
} from "../marketplace/limits.js";
import { marketplacePrice } from "../marketplace/price.js";
import type { MarketplaceProgress } from "../marketplace/progress.js";
import { validateMarketplaceInput } from "../marketplace/validate.js";
import {
  accessTokenOf,
  isManualAccount,
  type PlatformAccount,
  type PlatformCredentials,
  usesSessionProfile,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import {
  type AccessTokenProvider,
  isPublishHandoff,
  type Publisher,
  type PublishInput,
  type PublishResult,
  storedAccessToken,
} from "../ports/publisher.js";
import type { PlatformTokenRefresher } from "../ports/token-refresher.js";
import type { UfValueSource } from "../ports/uf-value-source.js";

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
  scheduledPayloadSchema,
} from "../publication.js";
import { withDryRun } from "../publish/dry-run.js";
import {
  buildPublishInput,
  checkPublishInput,
  publishAttemptRecord,
  publishInputInvalid,
} from "../publish/input.js";
import {
  isOutcomeUnknown,
  type ManualHandoffProgress,
  outcomeUnknown,
  pendingSend,
} from "../publish/outcome.js";
import {
  consecutiveLimitWaits,
  MAX_LIMIT_WAITS,
  retryAtAfter,
  waitMinutesOf,
} from "../publish/wait.js";
import { accountPublishMode, liveModeMismatch } from "../publish-mode.js";
import { scrubMessage } from "../redact.js";
import { listingIdOf } from "../subject.js";
import { xSpendLimitOf } from "../x/account.js";
import { xLinkNotAllowed, xPostCostUsd, xPostHasLink } from "../x/cost.js";
import {
  accessTokenProvider,
  ROTATING_TOKEN_PLATFORMS,
  rotatingAccessTokenProvider,
} from "./ensure-access-token.js";
import { expireAccountIfRejected } from "./platform-auth.js";
import { modeOf, publicationNotFound } from "./publication-start.js";

/**
 * Un paso secundario que falló sin cortar el intento (la bitácora, el estado de la cuenta o del
 * aviso): el worker lo registra, solo con el id y el código.
 */
export type PublishWarning = {
  publicationId: string;
  step:
    | "attempt_event"
    | "mark_failed"
    | "mark_outcome_unknown"
    | "wait_limit"
    | "listing_active"
    | "account_status"
    | "remote_state";
  code: string;
};

/** Lo que el corredor publica a mano: la nota del intento (spec F7 §4.8, ADR-0023). */
export const BY_HAND_NOTE = "publícalo tú con el texto y las fotos listos";

export type PublishPublicationDeps = {
  /** `listByStatus` y `countLiveAttemptsSince`: el límite de Marketplace (spec F5 §4.7). */
  publications: Pick<
    PublicationRepository,
    | "get"
    | "transition"
    | "saveProgress"
    | "addEvent"
    | "listByStatus"
    | "countLiveAttemptsSince"
    | "listEvents"
    | "setCostUsd"
    | "reserveCostUsd"
  >;
  /**
   * El post de una publicación de X (F9-T16): su marca `xLinkAllowed` decide si un texto con enlace
   * puede salir. Sin esto, un texto de X con enlace no sale (`X_LINK_NOT_ALLOWED`).
   */
  posts?: Pick<PostRepository, "get">;
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
  /** Los medios del sujeto de la publicación (aviso o post, ADR-0029). */
  media: Pick<MediaRepository, "listBySubject">;
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
  /**
   * El `PUBLISH_MODE` **del servidor** (el del worker): con el corredor de la publicación decide, vía
   * `effectivePublishMode`, si una pedida en `live` se puede publicar (D11, ADR-0036).
   */
  workerMode: PublishMode;
  /** Marketplace: avisos por día y cuenta (`MARKETPLACE_DAILY_LIMIT`; por defecto 3, D8). */
  marketplaceDailyLimit?: number;
  /**
   * Si el ambiente permite el formulario automático de Marketplace (`marketplaceAutomationEnabled`,
   * config; spec F8 §4.10). Obligatorio, para no olvidarlo: publicar con una cuenta de perfil falla
   * con `MARKETPLACE_AUTOMATION_NOT_ALLOWED` sin abrir nada cuando es `false`.
   */
  marketplaceAutomation: boolean;
  /** La fuente de la UF para el precio de Marketplace (spec F5 §4.6); `null` sin el token. */
  uf?: UfValueSource | null;
  /**
   * La renovación del token de las plataformas con token que rota (X y TikTok,
   * `ROTATING_TOKEN_PLATFORMS`; ADR-0029 punto 11): el intento lo asegura con
   * `ensureRotatingAccessToken`. Sin la de una plataforma, un token por vencer es
   * `TOKEN_REFRESH_NOT_CONFIGURED`.
   */
  tokenRefreshers?: Readonly<Partial<Record<Platform, PlatformTokenRefresher>>>;
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
  /**
   * Marketplace (ADR-0017): el formulario quedó listo y espera el clic del operador; o una cuenta a
   * mano (ADR-0023, ADR-0029 punto 9) dejó el texto y los medios listos sin llamar a la red.
   */
  | { outcome: "awaiting_manual_confirm"; publication: Publication }
  /** ADR-0029 punto 8: no se sabe si la red publicó; espera la palabra del operador. */
  | { outcome: "outcome_unknown"; publication: Publication }
  /** Un límite de la plataforma (F6, ADR-0018): quedó programada para `retryAt`. */
  | { outcome: "rescheduled"; publication: Publication; retryAt: Date }
  /** No estaba en `publishing` (ya terminó, se descartó o la tomó otro intento): no se publicó. */
  | { outcome: "skipped"; status: Publication["status"] };

/**
 * La espera ante un límite (spec F6 §4.5, ADR-0018 punto 6): si el error trae la señal de espera,
 * la plataforma no es de paso manual (Marketplace nunca se reprograma sola) y la publicación lleva
 * menos de 3 esperas seguidas, pasa `publishing` → `scheduled` para cuando se libere, con su propio
 * modo, el motivo en `last_error` y el progreso intacto (el publisher retoma desde él). Vale igual
 * para un aviso y un post (F9-T07): el disparo de cada minuto la retoma. `null` si no
 * corresponde esperar, o si la bitácora o la transición fallaron por algo que no es pasajero
 * (entonces sigue el camino de siempre, `failed`). Un fallo pasajero de la base se relanza.
 */
async function waitForLimit(
  deps: PublishPublicationDeps,
  {
    publication,
    error,
    now,
    mode,
    warn,
  }: {
    publication: Publication;
    error: AppError;
    now: Date;
    mode: ReturnType<typeof modeOf>;
    warn: (step: PublishWarning["step"], error: unknown) => void;
  },
): Promise<{ publication: Publication; retryAt: Date } | null> {
  const minutes = waitMinutesOf(error);
  if (minutes === null || requiresManualConfirm(publication.platform)) return null;
  try {
    const waits = consecutiveLimitWaits(await deps.publications.listEvents(publication.id));
    if (waits >= MAX_LIMIT_WAITS) return null;
    const retryAt = retryAtAfter(now, minutes);
    const updated = await deps.publications.transition(
      publication.id,
      {
        from: "publishing",
        to: "scheduled",
        changes: {
          dryRun: publication.dryRun,
          scheduledAt: retryAt,
          lastError: lastErrorOf(error),
        },
      },
      {
        actor: "system",
        payload: scheduledPayloadSchema.parse({
          mode,
          scheduledAt: retryAt.toISOString(),
          reason: "rate_limit",
        }),
      },
    );
    return { publication: updated, retryAt };
  } catch (failure) {
    warn("wait_limit", failure);
    if (isAppError(failure) && failure.retriable) throw failure;
    return null;
  }
}

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
 * 7 bis. Un límite de la plataforma (F6, ADR-0018): si el error trae la señal `waitMinutes`, la
 *    plataforma no es de paso manual y van menos de 3 esperas seguidas (un aviso o un post: el
 *    disparo de cada minuto ve los dos desde F9-T07), en vez del paso 7 la
 *    publicación pasa a `scheduled` para cuando se libere (con su modo y el progreso intacto), el
 *    intento queda `rescheduled` y se devuelve `outcome: "rescheduled"` sin relanzar.
 * 7 ter. Resultado dudoso (F9, ADR-0029 punto 8): un `OUTCOME_UNKNOWN` del publisher (encontró su
 *    progreso "enviando" sin resultado, o el envío falló sin certeza; `sendOnce`) **no** se
 *    reintenta: la publicación pasa a `outcome_unknown` con el motivo en `last_error`, el intento
 *    queda `outcome_unknown` y se devuelve `outcome: "outcome_unknown"` sin relanzar. El operador
 *    la resuelve con `resolvePublication`. Si la base no responde, se relanza reintentable: el
 *    reintento vuelve a dar `OUTCOME_UNKNOWN` sin llamar a la red.
 * Sobre un sujeto (F9-T06): los medios son los del sujeto (`listBySubject`), el input lleva el
 * idioma de la publicación y el texto de cada red (`socialCaption`), y un post nunca pasa a
 * `active`. Una cuenta en modo `manual` (`isManualAccount`, ADR-0029 punto 9) nunca llama a la red:
 * deja el texto y los medios listos (`awaiting_manual_confirm`) y el operador confirma con el
 * enlace (`confirmManualPublication`). El token de X y TikTok lo asegura
 * `ensureRotatingAccessToken` (ADR-0029 punto 11).
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
    // Un post nunca pasa a `active` (ADR-0029, punto 4): solo el aviso.
    if (publication.dryRun || publication.subject.kind !== "listing") return;
    await deps.listings
      .changeStatus(publication.subject.id, "ready", "active")
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
    extra: {
      error?: PublicationError;
      sent?: PublishAttemptRecord | null;
      notes?: string[];
      retryAt?: Date;
    },
  ) => {
    const payload: PublishAttemptPayload = publishAttemptPayloadSchema.parse({
      mode,
      attempt: publication.attempts,
      retry: retryCount,
      result,
      ...(extra.error === undefined ? {} : { error: extra.error }),
      ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt.toISOString() }),
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
  let result: PublishResult | null = null;
  let handoff: {
    notes: string[];
    simulated: boolean;
    input: PublishInput;
    byHand?: true;
  } | null = null;
  try {
    const prepared = await prepareAttempt(deps, publication, now(), signal);
    sent = prepared.sent;
    if (prepared.kind === "byHand" && prepared.alreadySent !== null) {
      // Un envío automático anterior ya salió: se guarda como publicado, sin traspaso.
      result = { ...prepared.alreadySent, simulated: false };
    } else if (prepared.kind === "byHand") {
      // A mano: nada que llamar ni ventana que abrir; el traspaso es de core (ADR-0023).
      handoff = {
        notes: [BY_HAND_NOTE],
        simulated: publication.dryRun,
        input: prepared.input,
        byHand: true,
      };
    } else {
      const attempt = prepared;
      const outcome = await attempt.target.publish(attempt.input, {
        account: attempt.account,
        credentials: attempt.credentials,
        accessToken: attempt.accessToken,
        progress: publication.progress,
        saveProgress: async (progress) => {
          await deps.publications.saveProgress(publicationId, progress);
        },
        ...(signal === undefined ? {} : { signal }),
      });
      // Un "formulario listo" (ADR-0017) solo puede venir de un publisher con paso manual, y uno con
      // paso manual nunca da por publicado: cualquier mezcla es un error de programación.
      const manual = attempt.target.manualConfirm === true;
      if (isPublishHandoff(outcome) !== manual) {
        throw new AppError(
          "INTERNAL_ERROR",
          manual
            ? "El publisher de una plataforma con clic final del operador dio el aviso por publicado"
            : "El publisher dejó el formulario para el clic final sin declarar un paso manual",
        );
      }
      if (isPublishHandoff(outcome)) {
        handoff = {
          notes: outcome.notes ?? [],
          simulated: outcome.simulated,
          input: attempt.input,
        };
      } else {
        result = outcome;
      }
    }
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
    // Resultado dudoso (ADR-0029 punto 8): no se reintenta; el operador dice si salió.
    if (isOutcomeUnknown(error)) {
      try {
        const unknown = await deps.publications.transition(
          publicationId,
          { from: "publishing", to: "outcome_unknown", changes: { lastError: lastErrorOf(error) } },
          { actor: "system", payload: { mode, code: error.code } },
        );
        await addAttempt("outcome_unknown", { error: lastErrorOf(error), sent });
        return { outcome: "outcome_unknown", publication: unknown };
      } catch (failure) {
        warn("mark_outcome_unknown", failure);
        // Si la base no respondió, la cola reintenta: el progreso "enviando" vuelve a dar
        // `OUTCOME_UNKNOWN` sin llamar a la red.
        if (isAppError(failure) && failure.retriable) {
          await addAttempt("retry", { error: lastErrorOf(error), sent });
          throw failure;
        }
        // Otro error (la publicación cambió de estado entretanto): si quedó en `publishing`, la
        // vigilancia de cada hora la reencola y el "enviando" la vuelve a llevar a `outcome_unknown`.
        throw error;
      }
    }
    await expireAccountIfRejected(
      deps.platformAccounts,
      publication.platformAccountId,
      error,
      (failure) => warn("account_status", failure),
    );
    const waited = await waitForLimit(deps, { publication, error, now: now(), mode, warn });
    if (waited !== null) {
      await addAttempt("rescheduled", { error: lastErrorOf(error), sent, retryAt: waited.retryAt });
      return { outcome: "rescheduled", publication: waited.publication, retryAt: waited.retryAt };
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

  if (handoff !== null) {
    return awaitManualConfirm(deps, {
      publication,
      handoff,
      sent,
      now: now(),
      mode,
      addAttempt,
    });
  }
  if (result === null) throw new AppError("INTERNAL_ERROR", "El intento terminó sin resultado");

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

/**
 * Pasa la publicación a `awaiting_manual_confirm` (spec F5 §4.3, ADR-0017) con el progreso de este
 * intento, armado aquí (en Marketplace, `attempt`, `simulated`, `formReadyAt`, las fotos y el
 * precio; en una cuenta a mano de otra red, `manualHandoffProgressSchema`): así un
 * `windowClosedAt` de un intento anterior nunca se arrastra. Si no se puede guardar,
 * `PUBLISH_RESULT_NOT_SAVED` (reintentable): el worker cierra la ventana y el reintento abre un
 * formulario nuevo (no se publicó nada).
 */
async function awaitManualConfirm(
  deps: PublishPublicationDeps,
  {
    publication,
    handoff,
    sent,
    now,
    mode,
    addAttempt,
  }: {
    publication: Publication;
    handoff: { notes: string[]; simulated: boolean; input: PublishInput; byHand?: true };
    sent: PublishAttemptRecord | null;
    now: Date;
    mode: ReturnType<typeof modeOf>;
    addAttempt: (
      result: PublishAttemptResult,
      extra: { sent?: PublishAttemptRecord | null; notes?: string[]; error?: PublicationError },
    ) => Promise<void>;
  },
): Promise<PublishPublicationResult> {
  const { input } = handoff;
  // Marketplace guarda su formulario (precio, fotos, ventana); las demás, el traspaso genérico.
  const progress: MarketplaceProgress | ManualHandoffProgress =
    publication.platform === "fb_marketplace"
      ? {
          attempt: publication.attempts,
          simulated: handoff.simulated,
          formReadyAt: now.toISOString(),
          photos: input.media.length,
          priceClp: input.priceClp ?? 0,
          ...(input.uf == null ? {} : { ufValue: input.uf.value, ufDate: input.uf.date }),
          ...(handoff.byHand === true ? { byHand: true as const } : {}),
        }
      : {
          manual: {
            attempt: publication.attempts,
            simulated: handoff.simulated,
            readyAt: now.toISOString(),
            media: input.media.length,
          },
        };
  let waiting: Publication;
  try {
    waiting = await deps.publications.transition(
      publication.id,
      {
        from: "publishing",
        to: "awaiting_manual_confirm",
        changes: { progress, lastError: null },
      },
      { actor: "system", payload: { mode } },
    );
  } catch (failure) {
    const error = new AppError(
      "PUBLISH_RESULT_NOT_SAVED",
      handoff.byHand === true
        ? "Quedó listo para publicar a mano, pero no se pudo guardar: se reintenta"
        : "El formulario quedó listo, pero no se pudo guardar: se vuelve a abrir uno nuevo",
      { retriable: true, cause: failure, details: { publicationId: publication.id } },
    );
    // El intento abrió Facebook (o, a mano, quedó listo): deja su evento (con el perfil, cuenta
    // para el límite diario, spec F5 §4.7).
    await addAttempt("retry", { sent, notes: handoff.notes, error: lastErrorOf(error) });
    throw error;
  }
  await addAttempt("awaiting_manual_confirm", { sent, notes: handoff.notes });
  return { outcome: "awaiting_manual_confirm", publication: waiting };
}

/**
 * Marketplace (spec F5 §4.7): un formulario a la vez por cuenta (otra publicación de la cuenta
 * esperando el clic → `MARKETPLACE_FORM_OPEN`; las `publishing` ya las serializa el worker) y, en
 * `live`, como mucho `marketplaceDailyLimit` intentos por día de Santiago (los `publish_attempt`
 * de hoy; este todavía no dejó el suyo) → `MARKETPLACE_DAILY_LIMIT`. Los dos, no reintentables.
 */
async function requireManualCapacity(
  deps: PublishPublicationDeps,
  publication: Publication,
  now: Date,
): Promise<void> {
  const waiting = (await deps.publications.listByStatus("awaiting_manual_confirm")).find(
    (other) =>
      other.platformAccountId === publication.platformAccountId && other.id !== publication.id,
  );
  if (waiting !== undefined) throw marketplaceFormOpen(waiting.id);
  if (publication.dryRun) return;
  const limit = deps.marketplaceDailyLimit ?? DEFAULT_MARKETPLACE_DAILY_LIMIT;
  const today = await deps.publications.countLiveAttemptsSince(
    publication.platformAccountId,
    startOfDayIn(MARKETPLACE_TIME_ZONE, now),
  );
  if (today >= limit) throw marketplaceDailyLimitReached(limit);
}

/** El corredor de la publicación tiene que ser propio para usar el perfil del navegador. */
async function requireAutomationAllowed(
  deps: PublishPublicationDeps,
  publication: Publication,
): Promise<void> {
  const listing = await deps.listings.get(listingIdOf(publication.subject));
  const broker = listing === null ? null : await deps.brokers.findById(listing.brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe el corredor de esta publicación");
  }
  assertMarketplaceAutomationAllowed(broker, deps.marketplaceAutomation);
}

/** Todo lo que se revisa y arma antes de llamar a la plataforma. */
async function prepareAttempt(
  deps: PublishPublicationDeps,
  publication: Publication,
  now: Date,
  signal: AbortSignalLike | undefined,
) {
  const account = await deps.platformAccounts.get(publication.platformAccountId);
  // Las dos llaves (ADR-0036): una publicación fijada en `live` solo sale si el servidor sigue en
  // `live` y su marca sigue encendida (apagarla entre medio la detiene sin llamar a la plataforma).
  // Sin cuenta no hay nada que decidir aquí: el intento falla enseguida con `ACCOUNT_NOT_CONNECTED`.
  if (
    !publication.dryRun &&
    account !== null &&
    (await accountPublishMode(deps, deps.workerMode, account)) === "dry-run"
  ) {
    throw liveModeMismatch({
      what: "Se pidió publicar en vivo",
      nothing: "no se publicó nada",
      serverMode: deps.workerMode,
      byHand: "descártala",
    });
  }
  if (account === null || account.status !== "connected") {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de esta publicación no está conectada: reconéctala o descártala",
      { details: { accountStatus: account?.status ?? null } },
    );
  }
  // Marketplace: el clic final siempre es del operador (ADR-0017).
  const manual = requiresManualConfirm(publication.platform);
  // A mano, por cuenta (ADR-0029 punto 9): Marketplace a mano (F7, ADR-0023) o una cuenta en modo
  // `manual` de otra red. Nunca llama a la red: sin publisher, credenciales, límite diario ni "un
  // formulario a la vez".
  const byHand = isManualAccount(account);
  // El formulario automático, solo para un corredor propio y donde el ambiente lo permite (también
  // con una cuenta de perfil conectada antes de F7). Va **antes** de buscar el publisher: en
  // producción el worker no registra el de Marketplace (F8-T20), y el motivo es este, no
  // `PUBLISHER_NOT_CONFIGURED`.
  if (manual && !byHand) await requireAutomationAllowed(deps, publication);
  const publisher = byHand ? undefined : deps.publishers[publication.platform];
  if (!byHand && publisher === undefined) {
    throw new AppError("PUBLISHER_NOT_CONFIGURED", "Esta plataforma todavía no se puede publicar", {
      details: { platform: publication.platform },
    });
  }
  if (manual && !byHand) await requireManualCapacity(deps, publication, now);
  // Marketplace no guarda credenciales: su sesión vive en el perfil del navegador (ADR-0017). A
  // mano tampoco se leen: no se llama a la red.
  const stored =
    byHand || usesSessionProfile(publication.platform)
      ? null
      : await readCredentials(deps, publication, account.id);
  const content = await deps.contents.get(publication.contentId);
  if (content === null) {
    throw new AppError("CONTENT_NOT_FOUND", "No existe el texto de esta publicación", {
      details: { contentId: publication.contentId },
    });
  }
  let input: PublishInput = await buildPublishInput(deps, {
    publication,
    content,
    media: await deps.media.listBySubject(publication.subject),
  });
  if (manual && input.listing !== undefined) {
    const price = await marketplacePrice(input.listing, {
      uf: deps.uf ?? null,
      now,
      ...(signal === undefined ? {} : { signal }),
    });
    input = { ...input, priceClp: price.priceClp, uf: price.uf };
  }
  if (publisher === undefined) {
    if (manual) {
      // A mano, las reglas del formulario igual: el corredor no copia algo que Facebook rechazará.
      const issues = validateMarketplaceInput(input);
      if (issues.length > 0) throw publishInputInvalid(publication.id, issues);
    } else {
      // Otra red a mano: sus reglas, si su publisher está registrado (`validate` es pura).
      const rules = deps.publishers[publication.platform];
      if (rules !== undefined) checkPublishInput(rules, input);
    }
    // Un envío automático pendiente (la cuenta pasó a modo `manual` con un reintento en curso): la
    // misma revisión que `sendOnce`. Si pudo haber salido, es dudoso: no se ofrece publicarlo a
    // mano otra vez; si salió y no se alcanzó a guardar, se guarda como publicado.
    const previous = manual ? null : pendingSend(publication.progress);
    if (previous?.kind === "unknown") throw outcomeUnknown(previous.reason);
    return {
      kind: "byHand" as const,
      input,
      account,
      sent: publishAttemptRecord(input, account),
      alreadySent: previous?.kind === "sent" ? previous.result : null,
    };
  }
  if (!publication.dryRun) checkPublishInput(publisher, input);
  // X cobra cada post (spec F9 §4.12): la marca del enlace, el tope del mes y el costo, antes de
  // llamar a la red.
  if (publication.platform === "x") await requireXBudget(deps, publication, account, input, now);
  if (stored === null) {
    return {
      input,
      account,
      credentials: undefined,
      accessToken: undefined,
      sent: publishAttemptRecord(input, account),
      target: publication.dryRun ? withDryRun(publisher) : publisher,
      kind: "publisher" as const,
    };
  }
  const { credentials, accessToken } = publishToken(deps, publication, account.id, stored);
  return {
    input,
    account,
    credentials,
    accessToken,
    sent: publishAttemptRecord(input, account),
    target: publication.dryRun ? withDryRun(publisher) : publisher,
    kind: "publisher" as const,
  };
}

/**
 * X (spec F9 §4.4 y §4.12, F9-T16), antes de llamar a la red y en los dos modos:
 * 1. con un envío anterior en el progreso (dudoso o hecho), nada: `sendOnce` decide sin llamar y
 *    sin cobrar otra vez;
 * 2. un texto con enlace necesita la marca explícita del operador en el post (`xLinkAllowed`): sin
 *    ella, `X_LINK_NOT_ALLOWED` (no reintentable), aunque el texto se haya aprobado antes de quitar
 *    la marca;
 * 3. en `live`, reserva el costo estimado de este post (US$0,015, o US$0,20 con enlace) en
 *    `cost_usd` con `reserveCostUsd` (F9.5-T08): de forma atómica, con un candado por cuenta, el
 *    gasto del mes de la cuenta (mes de Chile, sin esta publicación) más este costo no puede pasar
 *    `spendLimitUsd` (por defecto US$10). Si no cabe, `X_SPEND_LIMIT_REACHED` (no reintentable) y la
 *    publicación queda `failed` con la causa. Dos publicaciones a la vez de la misma cuenta se
 *    esperan: nunca pasan las dos por encima del tope. La reserva se libera sola si la publicación
 *    termina `failed` o `cancelled` (dejan de contar, `COST_COUNTED_STATUSES`);
 * 4. en `dry-run`, anota el costo estimado igual, como referencia (no cuenta para el tope: solo
 *    suman las de `live`).
 */
async function requireXBudget(
  deps: PublishPublicationDeps,
  publication: Publication,
  account: Pick<PlatformAccount, "id" | "meta">,
  input: PublishInput,
  now: Date,
): Promise<void> {
  if (pendingSend(publication.progress).kind !== "none") return;
  const costUsd = xPostCostUsd(input.caption);
  if (xPostHasLink(input.caption)) {
    const postId = publication.subject.kind === "post" ? publication.subject.id : null;
    const post = postId === null || deps.posts === undefined ? null : await deps.posts.get(postId);
    if (post?.xLinkAllowed !== true) throw xLinkNotAllowed(postId);
  }
  if (publication.dryRun) {
    await deps.publications.setCostUsd(publication.id, costUsd);
    return;
  }
  // Atómica (candado por cuenta): si no cabe, `X_SPEND_LIMIT_REACHED` sin anotar nada.
  await deps.publications.reserveCostUsd(publication.id, account.id, costUsd, {
    limitUsd: xSpendLimitOf(account),
    since: chileMonthRange(chileMonthOf(now)).from,
  });
}

/**
 * El token del intento, por plataforma (ADR-0015; ADR-0029 punto 11), siempre fuera de los
 * candados del aviso y del post:
 * - Portal: `ensureAccessToken` (Mercado Libre);
 * - X y TikTok (`ROTATING_TOKEN_PLATFORMS`): `ensureRotatingAccessToken`, con la renovación de la
 *   plataforma (`tokenRefreshers`) y el candado de credenciales;
 * - las demás (Instagram, LinkedIn): el guardado, que falla cerrado ante `rejectedToken`.
 * Donde el token se renueva, el contexto no lleva el `refreshToken` (es de un solo uso y queda viejo
 * después de renovar) y `credentials.accessToken` puede estar vencido: el publisher usa siempre
 * `ctx.accessToken` (`platformContextOf` solo cae en él sin proveedor).
 */
function publishToken(
  deps: PublishPublicationDeps,
  publication: Publication,
  accountId: string,
  stored: PlatformCredentials,
): { credentials: PlatformCredentials; accessToken: AccessTokenProvider } {
  const onWarning = (warning: { code: string }) =>
    deps.onWarning?.({ publicationId: publication.id, step: "account_status", code: warning.code });
  const clock = deps.now === undefined ? {} : { now: deps.now };
  if (publication.platform === "portal_inmobiliario") {
    return {
      credentials: { accessToken: accessTokenOf(stored) },
      accessToken: accessTokenProvider(
        {
          platformAccounts: deps.platformAccounts,
          mercadoLibre: deps.mercadoLibre,
          ...clock,
          onWarning,
        },
        accountId,
      ),
    };
  }
  if (ROTATING_TOKEN_PLATFORMS.has(publication.platform)) {
    return {
      credentials: { accessToken: accessTokenOf(stored) },
      accessToken: rotatingAccessTokenProvider(
        {
          platformAccounts: deps.platformAccounts,
          refreshers: deps.tokenRefreshers ?? {},
          ...clock,
          onWarning,
        },
        accountId,
      ),
    };
  }
  return { credentials: stored, accessToken: storedAccessToken(stored) };
}

/** Las credenciales de la cuenta; si no se pueden leer, la cuenta pasa a `error` (`CREDENTIALS_UNREADABLE`). */
async function readCredentials(
  deps: PublishPublicationDeps,
  publication: Publication,
  accountId: string,
) {
  try {
    return await deps.platformAccounts.getCredentials(accountId);
  } catch (error) {
    if (isAppError(error) && error.code === "CREDENTIALS_UNREADABLE") {
      await deps.platformAccounts
        .changeStatus(accountId, "connected", "error")
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
}
