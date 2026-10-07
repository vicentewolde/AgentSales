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

export type EnsureAccessTokenDeps = {
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
};

export type EnsureAccessTokenOptions = {
  /**
   * Refresca aunque el token parezca vigente: lo pide quien recibió un 401 con él
   * (`isMercadoLibreTokenRejected`). Si mientras esperaba el candado otro ya lo refrescó, usa ese.
   */
  force?: boolean;
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

function accessTokenExpiresAtOf(meta: Record<string, unknown>): Date | null {
  const { accessTokenExpiresAt } = accessTokenClockSchema.parse(meta);
  return accessTokenExpiresAt === undefined ? null : new Date(accessTokenExpiresAt);
}

/** Las credenciales de Mercado Libre: siempre con el `refresh_token` (ADR-0015). */
function mercadoLibreCredentials(
  accountId: string,
  credentials: PlatformCredentials,
): Required<PlatformCredentials> {
  if (credentials.refreshToken === undefined) {
    throw new AppError(
      "CREDENTIALS_INVALID",
      "Faltan datos del acceso guardado de Mercado Libre: reconecta la cuenta",
      { details: { accountId, reason: "refresh_token_missing" } },
    );
  }
  return { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken };
}

/** Lo que pasó dentro del candado; lo que cambia el estado de la cuenta se hace después. */
type LockedOutcome =
  | { kind: "token"; accessToken: string }
  | { kind: "rejected" }
  | { kind: "user_mismatch" };

/**
 * Un `access_token` vigente de una cuenta de Mercado Libre (spec F4 §4.3, ADR-0015), para publicar,
 * `preflight`, las operaciones, el sync, el catálogo y `ml:smoke`, **siempre fuera** del
 * `ListingLock`:
 * 1. la cuenta tiene que existir (`ACCOUNT_NOT_FOUND`), ser de Portal (`ACCOUNT_REFRESH_UNSUPPORTED`)
 *    y estar conectada (`ACCOUNT_NOT_CONNECTED`);
 * 2. si a `meta.accessTokenExpiresAt` le quedan más de 30 min (y no es `force`), devuelve el token
 *    guardado **sin bloquear**;
 * 3. si no, sin el par de la app es `MERCADOLIBRE_NOT_CONFIGURED` (sin llamar, la cuenta no
 *    cambia); con él, entra al candado de credenciales, **vuelve a leer** (otro pudo refrescar
 *    mientras esperaba) y refresca solo si sigue por vencer (con `force`, si el token es el mismo
 *    que se rechazó). Guarda el par nuevo, el vencimiento del `access_token`, `tokenRefreshedAt` y
 *    el horizonte de 6 meses **antes** de devolver el token: si guardar falla, no se entrega.
 * Errores: `invalid_grant` (`ML_AUTH_INVALID`) deja la cuenta `expired` y sube; credenciales
 * ilegibles o sin `refresh_token` la dejan en `error`; un `user_id` distinto al refrescar la deja en
 * `error` (`ML_UNEXPECTED_RESPONSE`); la red, el tope, `ML_APP_CREDENTIALS_INVALID` o el candado
 * ocupado (`ACCOUNT_LOCK_TIMEOUT`) suben **sin cambiar** la cuenta. Ninguno lleva un token.
 */
export async function ensureAccessToken(
  deps: EnsureAccessTokenDeps,
  accountId: string,
  { force = false, signal }: EnsureAccessTokenOptions = {},
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

  const markAs = async (to: "expired" | "error") => {
    // Si ya no estaba `connected` (una desconexión en paralelo), no se pisa.
    await deps.platformAccounts.changeStatus(accountId, "connected", to).catch(() => false);
  };
  const stillFresh = (current: PlatformAccount) => {
    const expiresAt = accessTokenExpiresAtOf(current.meta);
    return (
      expiresAt !== null && expiresAt.getTime() - now().getTime() > ACCESS_TOKEN_REFRESH_MARGIN_MS
    );
  };

  // El token que tiene quien llama: con `force`, solo se refresca si sigue siendo ese.
  let seen: Required<PlatformCredentials>;
  try {
    seen = mercadoLibreCredentials(
      accountId,
      await deps.platformAccounts.getCredentials(accountId),
    );
  } catch (error) {
    if (isAppError(error) && CREDENTIALS_BROKEN.has(error.code)) await markAs("error");
    throw error;
  }
  if (!force && stillFresh(account)) return seen.accessToken;

  const mercadoLibre = deps.mercadoLibre;
  if (mercadoLibre === null) {
    throw new AppError(
      "MERCADOLIBRE_NOT_CONFIGURED",
      "Falta configurar la app de Mercado Libre para renovar el acceso: anota ML_APP_ID y ML_CLIENT_SECRET en .env y reinicia",
    );
  }

  let outcome: LockedOutcome;
  try {
    outcome = await deps.platformAccounts.withCredentialsLock(
      accountId,
      async ({ account: locked, credentials, save }) => {
        const current = mercadoLibreCredentials(accountId, credentials);
        // Otro proceso refrescó mientras se esperaba el candado: su token sirve.
        if (force ? current.accessToken !== seen.accessToken : stillFresh(locked)) {
          return { kind: "token", accessToken: current.accessToken };
        }
        let refreshed: Awaited<ReturnType<MercadoLibreAuth["refresh"]>>;
        try {
          refreshed = await mercadoLibre.refresh(
            current.refreshToken,
            signal === undefined ? {} : { signal },
          );
        } catch (error) {
          if (isAppError(error) && error.code === "ML_AUTH_INVALID") return { kind: "rejected" };
          throw error;
        }
        if (refreshed.userId !== null && refreshed.userId !== locked.externalAccountId) {
          return { kind: "user_mismatch" };
        }
        const refreshedAt = now();
        // Antes de devolver el token: el `refresh_token` anterior ya no sirve (uso único).
        await save({
          credentials: { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken },
          tokenExpiresAt: new Date(
            refreshedAt.getTime() + MERCADOLIBRE_REFRESH_TOKEN_DAYS * DAY_MS,
          ),
          meta: {
            tokenRefreshedAt: refreshedAt.toISOString(),
            accessTokenExpiresAt: refreshed.accessTokenExpiresAt.toISOString(),
          },
        });
        return { kind: "token", accessToken: refreshed.accessToken };
      },
    );
  } catch (error) {
    if (isAppError(error) && CREDENTIALS_BROKEN.has(error.code)) await markAs("error");
    throw error;
  }

  if (outcome.kind === "token") return outcome.accessToken;
  if (outcome.kind === "rejected") {
    await markAs("expired");
    throw new AppError(
      "ML_AUTH_INVALID",
      "Mercado Libre ya no acepta el acceso de la cuenta (venció, se revocó o cambió la contraseña): reconéctala",
      { details: { accountId, reason: "refresh_rejected" } },
    );
  }
  await markAs("error");
  throw new AppError(
    "ML_UNEXPECTED_RESPONSE",
    "Mercado Libre renovó el acceso de otra cuenta: reconecta la cuenta",
    { details: { accountId, reason: "user_mismatch" } },
  );
}
