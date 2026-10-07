import { z } from "zod";
import type { AbortSignalLike } from "../abort.js";
import { AppError, isAppError } from "../errors.js";
import {
  MERCADOLIBRE_REFRESH_TOKEN_DAYS,
  type PlatformAccount,
  type PlatformCredentials,
} from "../platform-account.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";

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
  /** Corta el refresco; la espera del candado la acota `lock_timeout` (10 s), no la señal. */
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

/** ¿Le quedan al `access_token` de la cuenta más de 30 min? Sin la fecha, no. */
export function mercadoLibreTokenStillFresh(account: PlatformAccount, now: Date): boolean {
  const { accessTokenExpiresAt } = accessTokenClockSchema.parse(account.meta);
  return (
    accessTokenExpiresAt !== undefined &&
    new Date(accessTokenExpiresAt).getTime() - now.getTime() > ACCESS_TOKEN_REFRESH_MARGIN_MS
  );
}

/** Las credenciales de Mercado Libre: siempre con el `refresh_token` (ADR-0015), o `null`. */
function withRefreshToken(credentials: PlatformCredentials): Required<PlatformCredentials> | null {
  return credentials.refreshToken === undefined
    ? null
    : { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken };
}

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
 * entrega. Sin el par de la app, `MERCADOLIBRE_NOT_CONFIGURED` sin llamar.
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
        let refreshed: Awaited<ReturnType<MercadoLibreAuth["refresh"]>>;
        try {
          refreshed = await mercadoLibre.refresh(
            current.refreshToken,
            signal === undefined ? {} : { signal },
          );
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
          credentials: { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken },
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
  deps: MercadoLibreTokenDeps,
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

  let stored: Required<PlatformCredentials> | null;
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
