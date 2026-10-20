import { z } from "zod";
import type { AbortSignalLike } from "../abort.js";
import type { Platform } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  hasAccessToken,
  MERCADOLIBRE_REFRESH_TOKEN_DAYS,
  type PlatformAccount,
  type PlatformCredentials,
  type RefreshableCredentials,
  type TokenCredentials,
} from "../platform-account.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { AccessTokenProvider } from "../ports/publisher.js";
import type { PlatformTokenRefresher, RefreshedTokens } from "../ports/token-refresher.js";

/** Con menos de esto de vida, el `access_token` se refresca antes de usarlo (spec F4 §4.3). */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Credenciales guardadas que no sirven: la cuenta queda en `error` hasta reconectarla. */
const CREDENTIALS_BROKEN = new Set(["CREDENTIALS_UNREADABLE", "CREDENTIALS_INVALID"]);

export type MercadoLibreTokenDeps = {
  platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "getCredentials" | "withCredentialsLock" | "changeStatus"
  >;
  /**
   * El refresco de Mercado Libre, o `null` si falta el par de la app (`ML_APP_ID` y
   * `ML_CLIENT_SECRET`): entonces un token por vencer es `MERCADOLIBRE_NOT_CONFIGURED`, sin llamar
   * y sin cambiar la cuenta (Mercado Libre exige el par también para refrescar).
   */
  mercadoLibre: Pick<MercadoLibreAuth, "refresh"> | null;
  now?: () => Date;
  /**
   * Algo secundario que no corta: el estado de la cuenta no se pudo guardar
   * (`ACCOUNT_STATUS_NOT_SAVED`). Solo ids y códigos.
   */
  onWarning?: (warning: { accountId: string; code: string }) => void;
};

export type EnsureAccessTokenOptions = {
  /**
   * El token que Mercado Libre rechazó con un 401 (`isMercadoLibreTokenRejected`): se refresca solo
   * si el guardado sigue siendo ese. Si otro ya lo cambió, se devuelve el nuevo sin refrescar: así
   * un proceso con un token viejo no rota el par de nuevo (ADR-0015, seguimiento de F4-T07).
   */
  rejectedToken?: string;
  /**
   * Si ya se disparó, no se refresca (`ML_ABORTED`). No corta un refresco en curso: el par ya pudo
   * rotar, y perderlo obliga a reconectar; lo acota el tope de 10 s del cliente. La espera del
   * candado la acota `lock_timeout` (10 s).
   */
  signal?: AbortSignalLike;
};

/**
 * Solo el vencimiento del `access_token`, leído aparte del resto de `meta` (como el reloj de
 * Instagram, `refreshClockSchema`): una `meta` incompleta no deja la cuenta sin poder refrescarse;
 * sin la fecha, se refresca.
 */
const accessTokenClockSchema = z.object({
  accessTokenExpiresAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

/**
 * ¿Le quedan al `access_token` de la cuenta más de 30 min (`meta.accessTokenExpiresAt`)? Sin la
 * fecha, no. Lo comparten Mercado Libre y las plataformas con token que rota (X, TikTok).
 */
export function accessTokenStillFresh(account: PlatformAccount, now: Date): boolean {
  const { accessTokenExpiresAt } = accessTokenClockSchema.parse(account.meta);
  return (
    accessTokenExpiresAt !== undefined &&
    new Date(accessTokenExpiresAt).getTime() - now.getTime() > ACCESS_TOKEN_REFRESH_MARGIN_MS
  );
}

/** ¿Le quedan al `access_token` de la cuenta de Mercado Libre más de 30 min? Sin la fecha, no. */
export const mercadoLibreTokenStillFresh = accessTokenStillFresh;

/** Las credenciales de Mercado Libre: siempre con el `refresh_token` (ADR-0015), o `null`. */
function withRefreshToken(
  credentials: PlatformCredentials,
): (TokenCredentials & RefreshableCredentials) | null {
  return !hasAccessToken(credentials) || credentials.refreshToken === undefined
    ? null
    : { ...credentials, refreshToken: credentials.refreshToken };
}

/** La señal ya se disparó: no se empieza un refresco (nada cambió). */
const aborted = (accountId: string) =>
  new AppError("ML_ABORTED", "Se cortó el pedido antes de renovar el acceso de Mercado Libre", {
    retriable: true,
    details: { accountId },
  });

const missingRefreshToken = (accountId: string) =>
  new AppError(
    "CREDENTIALS_INVALID",
    "Faltan datos del acceso guardado de Mercado Libre: reconecta la cuenta",
    { details: { accountId, reason: "refresh_token_missing" } },
  );

/** Lo que pasó dentro del candado: el problema ya quedó marcado ahí y se lanza después. */
type LockedOutcome =
  | { kind: "refreshed" | "kept"; accessToken: string; account: PlatformAccount }
  | { kind: "rejected" | "user_mismatch" | "refresh_token_missing" };

export type MercadoLibreRefreshResult = {
  /** `refreshed`: lo refrescó esta llamada; `kept`: no hacía falta (otro ya lo había hecho). */
  outcome: "refreshed" | "kept";
  accessToken: string;
  account: PlatformAccount;
};

/**
 * El núcleo del refresco de Mercado Libre (spec F4 §4.3, ADR-0015), que comparten
 * `ensureAccessToken` y el refresco por plataforma (T08): entra al candado de credenciales,
 * pregunta a `shouldRefresh` con la cuenta y el token **releídos**, y solo entonces refresca.
 * Guarda el par, `tokenRefreshedAt`, `accessTokenExpiresAt` y `token_expires_at` = ahora + 180 días
 * (conserva `tokenExpiryEstimated: true`) **antes** de devolver el token: si guardar falla, no se
 * entrega. Sin el par de la app, `MERCADOLIBRE_NOT_CONFIGURED` sin llamar. Con la señal ya
 * disparada, `ML_ABORTED` sin llamar; una vez enviado, el refresco no se corta con la señal (el par
 * ya pudo rotar): lo acota el tope de 10 s del cliente.
 * Lo que cambia la cuenta queda marcado **dentro** del candado (`markProblem`), y el error se lanza
 * después: `invalid_grant` la deja `expired` (`ML_AUTH_INVALID`); sin `refreshToken`
 * (`CREDENTIALS_INVALID`) o un refresco de otro `user_id` (`ML_UNEXPECTED_RESPONSE`, el par se
 * descarta), en `error`; credenciales ilegibles, en `error`. La red, el tope,
 * `ML_APP_CREDENTIALS_INVALID` y el candado ocupado (`ACCOUNT_LOCK_TIMEOUT`) suben sin cambiarla.
 * Riesgo aceptado (ADR-0015): si Mercado Libre rotó el par y no se guarda (el proceso muere, el
 * guardado o el `COMMIT` fallan, o la respuesta se pierde por el tope), el par nuevo se pierde y el
 * próximo refresco da `invalid_grant`: hay que reconectar. Ninguno de estos errores lleva un token.
 */
export async function refreshMercadoLibreToken(
  deps: MercadoLibreTokenDeps,
  accountId: string,
  {
    shouldRefresh,
    signal,
  }: {
    shouldRefresh: (current: { account: PlatformAccount; accessToken: string }) => boolean;
    signal?: AbortSignalLike;
  },
): Promise<MercadoLibreRefreshResult> {
  const mercadoLibre = deps.mercadoLibre;
  if (mercadoLibre === null) {
    throw new AppError(
      "MERCADOLIBRE_NOT_CONFIGURED",
      "Falta configurar la app de Mercado Libre para renovar el acceso: anota ML_APP_ID y ML_CLIENT_SECRET en .env y reinicia",
    );
  }
  const now = deps.now ?? (() => new Date());
  if (signal?.aborted) throw aborted(accountId);

  let outcome: LockedOutcome;
  try {
    outcome = await deps.platformAccounts.withCredentialsLock(
      accountId,
      async ({ account, credentials, save, markProblem }): Promise<LockedOutcome> => {
        const current = withRefreshToken(credentials);
        if (current === null) {
          await markProblem("error");
          return { kind: "refresh_token_missing" };
        }
        if (!shouldRefresh({ account, accessToken: current.accessToken })) {
          return { kind: "kept", accessToken: current.accessToken, account };
        }
        if (signal?.aborted) throw aborted(accountId);
        let refreshed: Awaited<ReturnType<MercadoLibreAuth["refresh"]>>;
        try {
          // Sin la señal: cortar después de enviar el pedido perdería el par que Mercado Libre ya
          // rotó (seguimiento de F4-T08 en ADR-0015). Lo acota el tope de 10 s del cliente.
          refreshed = await mercadoLibre.refresh(current.refreshToken);
        } catch (error) {
          if (isAppError(error) && error.code === "ML_AUTH_INVALID") {
            await markProblem("expired");
            return { kind: "rejected" };
          }
          throw error;
        }
        // El par de otro usuario no se guarda (sería peor que reconectar): es la excepción a "no
        // se descarta un refresco por un campo accesorio".
        if (refreshed.userId !== null && refreshed.userId !== account.externalAccountId) {
          await markProblem("error");
          return { kind: "user_mismatch" };
        }
        const refreshedAt = now();
        const saved = await save({
          // Solo cambia el par: lo demás que guardaban las credenciales se conserva.
          credentials: {
            ...current,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          },
          tokenExpiresAt: new Date(
            refreshedAt.getTime() + MERCADOLIBRE_REFRESH_TOKEN_DAYS * DAY_MS,
          ),
          meta: {
            tokenRefreshedAt: refreshedAt.toISOString(),
            accessTokenExpiresAt: refreshed.accessTokenExpiresAt.toISOString(),
          },
        });
        return { kind: "refreshed", accessToken: refreshed.accessToken, account: saved };
      },
    );
  } catch (error) {
    // Credenciales ilegibles: el candado no llegó a `fn`, así que se marca aquí.
    if (isAppError(error) && CREDENTIALS_BROKEN.has(error.code)) {
      await markOutside(deps, accountId, "error");
    }
    throw error;
  }

  switch (outcome.kind) {
    case "refreshed":
    case "kept":
      return { outcome: outcome.kind, accessToken: outcome.accessToken, account: outcome.account };
    case "rejected":
      throw new AppError(
        "ML_AUTH_INVALID",
        "Mercado Libre ya no acepta el acceso de la cuenta (venció, se revocó o cambió la contraseña): reconéctala",
        { details: { accountId, reason: "refresh_rejected" } },
      );
    case "user_mismatch":
      throw new AppError(
        "ML_UNEXPECTED_RESPONSE",
        "Mercado Libre renovó el acceso de otra cuenta: reconecta la cuenta",
        { details: { accountId, reason: "user_mismatch" } },
      );
    case "refresh_token_missing":
      throw missingRefreshToken(accountId);
  }
}

/** Marca la cuenta fuera del candado; si no se puede, lo avisa (sin cortar el error original). */
async function markOutside(
  deps: {
    platformAccounts: Pick<PlatformAccountRepository, "changeStatus">;
    onWarning?: (warning: { accountId: string; code: string }) => void;
  },
  accountId: string,
  to: "expired" | "error",
): Promise<void> {
  try {
    await deps.platformAccounts.changeStatus(accountId, "connected", to);
  } catch {
    deps.onWarning?.({ accountId, code: "ACCOUNT_STATUS_NOT_SAVED" });
  }
}

/**
 * El proveedor de token de una cuenta de Portal (`AccessTokenProvider`, el del catálogo y el del
 * contexto del publisher, ADR-0015 punto 7), con `ensureAccessToken`.
 */
export const accessTokenProvider =
  (deps: MercadoLibreTokenDeps, accountId: string): AccessTokenProvider =>
  (options) =>
    ensureAccessToken(deps, accountId, options);

/**
 * Un `access_token` vigente de una cuenta de Mercado Libre (spec F4 §4.3, ADR-0015), para publicar,
 * `preflight`, las operaciones, el sync, el catálogo y `ml:smoke`, **siempre fuera** del
 * `ListingLock`:
 * 1. la cuenta tiene que existir (`ACCOUNT_NOT_FOUND`), ser de Portal (`ACCOUNT_REFRESH_UNSUPPORTED`)
 *    y estar conectada (`ACCOUNT_NOT_CONNECTED`), con su `refreshToken` (`CREDENTIALS_INVALID`, la
 *    cuenta queda en `error`);
 * 2. si a `meta.accessTokenExpiresAt` le quedan más de 30 min, devuelve el token guardado **sin
 *    bloquear** (con `rejectedToken`, solo si el guardado ya no es el rechazado);
 * 3. si no, refresca con `refreshMercadoLibreToken`, que vuelve a leer dentro del candado: refresca
 *    si el token guardado sigue siendo el rechazado o, sin `rejectedToken`, si sigue por vencer.
 * Errores y riesgo aceptado: los de `refreshMercadoLibreToken`.
 */
export async function ensureAccessToken(
  deps: MercadoLibreTokenDeps,
  accountId: string,
  { rejectedToken, signal }: EnsureAccessTokenOptions = {},
): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  if (account.platform !== "portal_inmobiliario") {
    throw new AppError(
      "ACCOUNT_REFRESH_UNSUPPORTED",
      `El acceso de ${account.platform} no se asegura así: solo el de Mercado Libre`,
      { details: { accountId, platform: account.platform } },
    );
  }
  if (account.status !== "connected" || !account.hasCredentials) {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de Mercado Libre no está conectada: conéctala de nuevo",
      { details: { accountId, accountStatus: account.status } },
    );
  }

  let stored: RefreshableCredentials | null;
  try {
    stored = withRefreshToken(await deps.platformAccounts.getCredentials(accountId));
    if (stored === null) throw missingRefreshToken(accountId);
  } catch (error) {
    if (isAppError(error) && CREDENTIALS_BROKEN.has(error.code)) {
      await markOutside(deps, accountId, "error");
    }
    throw error;
  }
  const rejectedIsStored = rejectedToken !== undefined && stored.accessToken === rejectedToken;
  if (!rejectedIsStored && mercadoLibreTokenStillFresh(account, now())) return stored.accessToken;

  const result = await refreshMercadoLibreToken(deps, accountId, {
    shouldRefresh: (current) =>
      rejectedToken !== undefined && current.accessToken === rejectedToken
        ? true
        : !mercadoLibreTokenStillFresh(current.account, now()),
    ...(signal === undefined ? {} : { signal }),
  });
  return result.accessToken;
}

/**
 * Las plataformas con access token de vida corta y refresh token que rota (ADR-0029 punto 11, spec
 * F9 §4.7): el intento asegura el token antes de publicar con `ensureRotatingAccessToken`. X tiene
 * un token de 2 h (F9-T16) y TikTok uno de 24 h (T26). Mercado Libre tiene su propio camino
 * (`ensureAccessToken`), anterior a F9.
 */
export const ROTATING_TOKEN_PLATFORMS: ReadonlySet<Platform> = new Set(["x", "tiktok"]);

export type RotatingTokenDeps = {
  platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "getCredentials" | "withCredentialsLock" | "changeStatus"
  >;
  /**
   * La renovación de cada plataforma (`packages/publishers`). Sin la de la plataforma de la cuenta,
   * un token por vencer es `TOKEN_REFRESH_NOT_CONFIGURED`, sin llamar ni cambiar la cuenta.
   */
  refreshers: Readonly<Partial<Record<Platform, PlatformTokenRefresher>>>;
  now?: () => Date;
  /** Algo secundario que no corta (`ACCOUNT_STATUS_NOT_SAVED`). Solo ids y códigos. */
  onWarning?: (warning: { accountId: string; code: string }) => void;
};

/** Lo que pasó dentro del candado de una cuenta con token que rota. */
type RotatingOutcome =
  | { kind: "refreshed" | "kept"; accessToken: string }
  | { kind: "rejected" | "refresh_token_missing" };

const rotatingMissingRefreshToken = (accountId: string) =>
  new AppError("CREDENTIALS_INVALID", "Faltan datos del acceso guardado: reconecta la cuenta", {
    details: { accountId, reason: "refresh_token_missing" },
  });

/**
 * Un `access_token` vigente de una cuenta con token que rota (X, TikTok; ADR-0029 punto 11), para
 * publicar, **siempre fuera** de los candados del aviso y del post. Las reglas son las de
 * `ensureAccessToken` (ADR-0015), con la renovación de la plataforma (`refreshers`):
 * 1. la cuenta tiene que existir (`ACCOUNT_NOT_FOUND`), ser de una plataforma con token que rota
 *    (`ACCOUNT_REFRESH_UNSUPPORTED`) y estar conectada (`ACCOUNT_NOT_CONNECTED`), con su
 *    `refreshToken` (`CREDENTIALS_INVALID`; la cuenta queda en `error`);
 * 2. si a `meta.accessTokenExpiresAt` le quedan más de 30 min, devuelve el guardado sin bloquear
 *    (con `rejectedToken`, solo si el guardado ya no es el rechazado);
 * 3. si no, sin la renovación de la plataforma, `TOKEN_REFRESH_NOT_CONFIGURED`; con la señal ya
 *    disparada, `TOKEN_REFRESH_ABORTED` (reintentable) sin llamar; y si no, entra al candado de
 *    credenciales, vuelve a mirar la cuenta y el token y solo entonces renueva **una** vez. Guarda
 *    el par, `tokenRefreshedAt`, `accessTokenExpiresAt` y `token_expires_at` (el vencimiento del
 *    refresh token, si la plataforma lo informa) **antes** de devolver el token.
 * Un refresh token rechazado (`isRejected`) deja la cuenta `expired` dentro del candado y es
 * `TOKEN_REFRESH_REJECTED` (no reintentable: reconectar); la red, el tope y el candado ocupado
 * (`ACCOUNT_LOCK_TIMEOUT`) suben sin cambiarla. Riesgo aceptado (ADR-0015): si la plataforma rotó
 * el par y no se guarda, el próximo refresco será rechazado y habrá que reconectar.
 */
export async function ensureRotatingAccessToken(
  deps: RotatingTokenDeps,
  accountId: string,
  { rejectedToken, signal }: EnsureAccessTokenOptions = {},
): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  if (!ROTATING_TOKEN_PLATFORMS.has(account.platform)) {
    throw new AppError(
      "ACCOUNT_REFRESH_UNSUPPORTED",
      `El acceso de ${account.platform} no se renueva al publicar`,
      { details: { accountId, platform: account.platform } },
    );
  }
  if (account.status !== "connected" || !account.hasCredentials) {
    throw new AppError("ACCOUNT_NOT_CONNECTED", "La cuenta no está conectada: conéctala de nuevo", {
      details: { accountId, accountStatus: account.status },
    });
  }
  const markOutsideRotating = (to: "expired" | "error") => markOutside(deps, accountId, to);

  let stored: RefreshableCredentials | null;
  try {
    stored = withRefreshToken(await deps.platformAccounts.getCredentials(accountId));
    if (stored === null) throw rotatingMissingRefreshToken(accountId);
  } catch (error) {
    if (isAppError(error) && CREDENTIALS_BROKEN.has(error.code)) await markOutsideRotating("error");
    throw error;
  }
  const rejectedIsStored = rejectedToken !== undefined && stored.accessToken === rejectedToken;
  if (!rejectedIsStored && accessTokenStillFresh(account, now())) return stored.accessToken;

  const refresher = deps.refreshers[account.platform];
  if (refresher === undefined) {
    throw new AppError(
      "TOKEN_REFRESH_NOT_CONFIGURED",
      `Falta configurar la app de ${account.platform} para renovar el acceso de la cuenta`,
      { details: { accountId, platform: account.platform } },
    );
  }
  const abortedRefresh = () =>
    new AppError("TOKEN_REFRESH_ABORTED", "Se cortó el pedido antes de renovar el acceso", {
      retriable: true,
      details: { accountId },
    });
  if (signal?.aborted) throw abortedRefresh();

  let outcome: RotatingOutcome;
  try {
    outcome = await deps.platformAccounts.withCredentialsLock(
      accountId,
      async ({ account: current, credentials, save, markProblem }): Promise<RotatingOutcome> => {
        const pair = withRefreshToken(credentials);
        if (pair === null) {
          await markProblem("error");
          return { kind: "refresh_token_missing" };
        }
        const mustRefresh =
          rejectedToken !== undefined && pair.accessToken === rejectedToken
            ? true
            : !accessTokenStillFresh(current, now());
        if (!mustRefresh) return { kind: "kept", accessToken: pair.accessToken };
        if (signal?.aborted) throw abortedRefresh();
        let refreshed: RefreshedTokens;
        try {
          // Sin la señal: cortar después de enviar perdería el par que la plataforma ya rotó.
          refreshed = await refresher.refresh(pair.refreshToken);
        } catch (error) {
          if (refresher.isRejected(error)) {
            await markProblem("expired");
            return { kind: "rejected" };
          }
          throw error;
        }
        const refreshedAt = now();
        await save({
          credentials: {
            ...pair,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          },
          tokenExpiresAt: refreshed.refreshTokenExpiresAt,
          meta: {
            tokenRefreshedAt: refreshedAt.toISOString(),
            accessTokenExpiresAt: refreshed.accessTokenExpiresAt.toISOString(),
          },
        });
        return { kind: "refreshed", accessToken: refreshed.accessToken };
      },
    );
  } catch (error) {
    if (isAppError(error) && CREDENTIALS_BROKEN.has(error.code)) await markOutsideRotating("error");
    throw error;
  }

  switch (outcome.kind) {
    case "refreshed":
    case "kept":
      return outcome.accessToken;
    case "rejected":
      throw new AppError(
        "TOKEN_REFRESH_REJECTED",
        "La plataforma ya no acepta el acceso de la cuenta (venció o se revocó): reconéctala",
        { details: { accountId, reason: "refresh_rejected" } },
      );
    case "refresh_token_missing":
      throw rotatingMissingRefreshToken(accountId);
  }
}

/** El proveedor de token de una cuenta con token que rota, para el contexto del publisher. */
export const rotatingAccessTokenProvider =
  (deps: RotatingTokenDeps, accountId: string): AccessTokenProvider =>
  (options) =>
    ensureRotatingAccessToken(deps, accountId, options);
