import { z } from "zod";
import type { AbortSignalLike } from "../abort.js";
import type { Platform } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { instagramAccountMetaSchema, type PlatformAccount } from "../platform-account.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { refreshMercadoLibreToken } from "./ensure-access-token.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Instagram solo refresca un token con al menos 24 h (nota §3.4): antes no se intenta. */
export const TOKEN_REFRESH_MIN_AGE_MS = 24 * HOUR_MS;
/** Se refresca cuando al token le quedan 30 días o menos (spec F3 §4.6); `force` salta este tope. */
export const TOKEN_REFRESH_WINDOW_MS = 30 * DAY_MS;
/**
 * Mercado Libre (spec F4 §4.3, ADR-0015): sin `force`, se refresca lo que lleva 7 días o más sin
 * refrescarse, para que el `refresh_token` no venza (6 meses) ni caiga por 4 meses sin uso.
 */
export const MERCADOLIBRE_REFRESH_AGE_MS = 7 * DAY_MS;

/** Las plataformas con refresco, cada una con su política. */
const REFRESHABLE_PLATFORMS: ReadonlySet<Platform> = new Set(["instagram", "portal_inmobiliario"]);

export type RefreshAccountTokensDeps = {
  platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "list" | "getCredentials" | "updateToken" | "changeStatus" | "withCredentialsLock"
  >;
  /** Solo el refresco del token largo (`refresh_access_token`). */
  instagram: Pick<InstagramAuth, "refresh">;
  /**
   * El refresco de Mercado Libre, o `null` si falta el par de la app (`ML_APP_ID` y
   * `ML_CLIENT_SECRET`): una cuenta a la que le toca es `MERCADOLIBRE_NOT_CONFIGURED`, sin llamar
   * y sin cambiarla (Mercado Libre exige el par también para refrescar).
   */
  mercadoLibre: Pick<MercadoLibreAuth, "refresh"> | null;
  now?: () => Date;
  /**
   * Algo secundario que no corta el refresco: una `meta` que no calza con el esquema de Instagram
   * (`ACCOUNT_META_UNREADABLE`, se refresca igual) o un cambio de estado de la cuenta que no se pudo
   * guardar (`ACCOUNT_STATUS_NOT_SAVED`). Solo ids y códigos.
   */
  onWarning?: (warning: { accountId: string; code: string }) => void;
};

/** Lo que pasó al refrescar una cuenta: `refreshed`, `skipped` (no tocaba) o `expired`. */
export const TOKEN_REFRESH_OUTCOMES = ["refreshed", "skipped", "expired"] as const;
export type TokenRefreshOutcome = (typeof TOKEN_REFRESH_OUTCOMES)[number];

/**
 * Por qué una cuenta no se refrescó:
 * - `too_recent` (Instagram): menos de 24 h desde el último refresco (o desde la conexión, con el
 *   token del panel); tampoco con `force`;
 * - `not_due`: todavía no toca, y `force` lo salta. En Instagram, le quedan más de 30 días y el
 *   vencimiento no es una estimación; en Mercado Libre, se refrescó (o conectó) hace menos de 7 días.
 */
export const TOKEN_REFRESH_SKIP_REASONS = ["too_recent", "not_due"] as const;
export type TokenRefreshSkipReason = (typeof TOKEN_REFRESH_SKIP_REASONS)[number];

/**
 * Por qué la cuenta quedó vencida:
 * - `token_expired`: ya había vencido (Instagram; no se llamó);
 * - `token_rejected`: la plataforma rechazó el token al refrescarlo (el 190 de Instagram,
 *   `IG_AUTH_INVALID`, o el `invalid_grant` de Mercado Libre, `ML_AUTH_INVALID`).
 */
export const TOKEN_EXPIRED_REASONS = ["token_expired", "token_rejected"] as const;
export type TokenExpiredReason = (typeof TOKEN_EXPIRED_REASONS)[number];

export type TokenRefreshResult =
  | { outcome: "refreshed"; account: PlatformAccount }
  | {
      outcome: "skipped";
      reason: TokenRefreshSkipReason;
      account: PlatformAccount;
      /** Desde cuándo se refrescaría. */
      refreshableAt: Date;
    }
  | { outcome: "expired"; reason: TokenExpiredReason; account: PlatformAccount };

type RefreshOptions = { force: boolean; signal: AbortSignalLike | undefined };

/**
 * Refresca el token de **una** cuenta con la política de su plataforma (spec F3 §4.6 y F4 §4.3):
 * lo usan el refresco a pedido de la API (`POST /accounts/:id/refresh`, síncrono) y el lote del job
 * `tokens.refresh`. La cuenta tiene que existir (`ACCOUNT_NOT_FOUND`), ser de Instagram o de Portal
 * (`ACCOUNT_REFRESH_UNSUPPORTED`) y estar `connected` (`ACCOUNT_NOT_CONNECTED`). Las reglas de cada
 * plataforma están en `refreshInstagram` y `refreshMercadoLibre`. Ningún resultado ni error lleva
 * el token.
 */
export async function refreshAccountToken(
  deps: RefreshAccountTokensDeps,
  {
    accountId,
    force = false,
    signal,
  }: { accountId: string; force?: boolean; signal?: AbortSignalLike },
): Promise<TokenRefreshResult> {
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  if (!REFRESHABLE_PLATFORMS.has(account.platform)) {
    throw new AppError(
      "ACCOUNT_REFRESH_UNSUPPORTED",
      `El acceso de ${account.platform} no se refresca: solo el de Instagram y el de Mercado Libre`,
      { details: { accountId, platform: account.platform } },
    );
  }
  if (account.status !== "connected" || !account.hasCredentials) {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta no está conectada: conéctala de nuevo para refrescar su acceso",
      { details: { accountId, accountStatus: account.status } },
    );
  }
  return refreshConnected(deps, account, { force, signal });
}

/** La política de la plataforma, sobre una cuenta ya revisada (con refresco y conectada). */
const refreshConnected = (
  deps: RefreshAccountTokensDeps,
  account: PlatformAccount,
  options: RefreshOptions,
): Promise<TokenRefreshResult> =>
  account.platform === "portal_inmobiliario"
    ? refreshMercadoLibre(deps, account, options)
    : refreshInstagram(deps, account, options);

/** Lo que dejó el lote: ids y códigos, nunca tokens. */
export type TokenRefreshReport = {
  refreshed: string[];
  expired: string[];
  skipped: number;
  /**
   * Las que fallaron sin cambiar (red, cupo, base, el candado ocupado o la falta del par de
   * Mercado Libre) o quedaron en `error` (credenciales ilegibles o incompletas).
   */
  failed: { accountId: string; code: string; retriable: boolean }[];
};

/**
 * El lote del job `tokens.refresh` (al arrancar el worker y una vez al día): refresca, sin `force`,
 * las cuentas de Instagram y de Portal conectadas a las que les toca según su política. Una cuenta
 * que falla no corta las demás: sin el par de Mercado Libre, las de Portal a las que les toca
 * quedan en `failed` (`MERCADOLIBRE_NOT_CONFIGURED`, no reintentable) sin cambiar, y el lote sigue.
 * Con la señal disparada (apagado) no empieza otra cuenta.
 */
export async function refreshAccountTokens(
  deps: RefreshAccountTokensDeps,
  { signal }: { signal?: AbortSignalLike } = {},
): Promise<TokenRefreshReport> {
  const report: TokenRefreshReport = { refreshed: [], expired: [], skipped: 0, failed: [] };
  const accounts = (await deps.platformAccounts.list()).filter(
    (account) =>
      REFRESHABLE_PLATFORMS.has(account.platform) &&
      account.status === "connected" &&
      account.hasCredentials,
  );
  for (const account of accounts) {
    if (signal?.aborted) break;
    try {
      const result = await refreshConnected(deps, account, { force: false, signal });
      if (result.outcome === "refreshed") report.refreshed.push(account.id);
      else if (result.outcome === "expired") report.expired.push(account.id);
      else report.skipped += 1;
    } catch (error) {
      report.failed.push({
        accountId: account.id,
        code: codeOf(error),
        retriable: !isAppError(error) || error.retriable,
      });
    }
  }
  return report;
}

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Solo el reloj del refresco, leído aparte del resto de `meta`: así una `meta` incompleta no pierde
 * su regla (las 24 h de Instagram, los 7 días de Mercado Libre), y el refresco, que escribe
 * `tokenRefreshedAt`, la vuelve a proteger.
 */
const refreshClockSchema = z.object({
  connectedAt: z.iso.datetime().optional().catch(undefined),
  tokenRefreshedAt: z.iso.datetime().nullish().catch(undefined),
});

/** La fecha del último refresco (o de la conexión), o `null` si `meta` no trae ninguna. */
function lastRefreshOf(meta: Record<string, unknown>): Date | null {
  const clock = refreshClockSchema.parse(meta);
  const last = clock.tokenRefreshedAt ?? clock.connectedAt;
  return last === undefined ? null : new Date(last);
}

/**
 * Mercado Libre (spec F4 §4.3, ADR-0015), con el núcleo `refreshMercadoLibreToken` (el candado de
 * credenciales y el guardado del par, los mismos de `ensureAccessToken`):
 * 1. Sin mínimo: con `force` (el refresco a pedido) siempre refresca.
 * 2. Sin `force`, solo si pasaron 7 días o más desde el último refresco (`meta.tokenRefreshedAt` o,
 *    si es `null`, `meta.connectedAt`; sin ninguna de las dos, refresca). Si no, `skipped`
 *    (`not_due`) sin tomar el candado ni pedir el par de la app. La regla se revisa **otra vez
 *    dentro del candado**, con la cuenta releída: si otro la refrescó mientras se esperaba (el
 *    núcleo responde `kept`), también es `skipped`.
 * 3. El vencimiento guardado (`token_expires_at`, el horizonte estimado del `refresh_token`) no deja
 *    la cuenta `expired` sin preguntar: se intenta y Mercado Libre decide.
 * 4. El núcleo guarda el par completo, `tokenRefreshedAt`, `accessTokenExpiresAt` y
 *    `token_expires_at` = ahora + `MERCADOLIBRE_REFRESH_TOKEN_DAYS`, y conserva
 *    `tokenExpiryEstimated: true`.
 * Errores: un rechazo del refresco (`ML_AUTH_INVALID`; la cuenta ya quedó `expired` dentro del
 * candado) es un resultado (`expired`, `token_rejected`, con la cuenta releída), como el 190 de
 * Instagram. Los demás suben: sin el par de la app, `MERCADOLIBRE_NOT_CONFIGURED` sin llamar ni
 * cambiar la cuenta; credenciales ilegibles o sin `refreshToken`, con la cuenta en `error`; la red,
 * el tope o el candado ocupado (`ACCOUNT_LOCK_TIMEOUT`, reintentable), sin cambiarla.
 */
async function refreshMercadoLibre(
  deps: RefreshAccountTokensDeps,
  account: PlatformAccount,
  { force, signal }: RefreshOptions,
): Promise<TokenRefreshResult> {
  const now = deps.now ?? (() => new Date());
  /** Desde cuándo le toca, o `null` si ya le toca. */
  const notDueUntil = (current: PlatformAccount): Date | null => {
    const last = lastRefreshOf(current.meta);
    if (last === null) return null;
    const dueAt = new Date(last.getTime() + MERCADOLIBRE_REFRESH_AGE_MS);
    return now().getTime() < dueAt.getTime() ? dueAt : null;
  };

  if (!force) {
    const refreshableAt = notDueUntil(account);
    if (refreshableAt !== null) {
      return { outcome: "skipped", reason: "not_due", account, refreshableAt };
    }
  }
  let keptUntil: Date | null = null;
  try {
    const result = await refreshMercadoLibreToken(deps, account.id, {
      shouldRefresh: ({ account: current }) => {
        if (force) return true;
        keptUntil = notDueUntil(current);
        return keptUntil === null;
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.outcome === "refreshed") return { outcome: "refreshed", account: result.account };
    // Otro la refrescó mientras se esperaba el candado.
    return {
      outcome: "skipped",
      reason: "not_due",
      account: result.account,
      refreshableAt: keptUntil ?? now(),
    };
  } catch (error) {
    if (isAppError(error) && error.code === "ML_AUTH_INVALID") {
      return { outcome: "expired", reason: "token_rejected", account: await reread(deps, account) };
    }
    throw error;
  }
}

/** Relee la cuenta después de que el núcleo la marcó; si no se puede, la que se tenía. */
async function reread(deps: RefreshAccountTokensDeps, account: PlatformAccount) {
  try {
    return (await deps.platformAccounts.get(account.id)) ?? account;
  } catch {
    return account;
  }
}

/**
 * Instagram (spec F3 §4.6):
 * 1. Un token vencido deja la cuenta en `expired` **sin llamar a Instagram**.
 * 2. Con menos de 24 h desde el último refresco no se refresca, tampoco con `force`. El último
 *    refresco es `meta.tokenRefreshedAt` o, si es `null` (token del panel), `meta.connectedAt`: así
 *    esa cuenta se refresca en cuanto pasan 24 h y obtiene el vencimiento real. Esas dos fechas
 *    se leen aparte del resto de `meta`: una `meta` que no calza con el esquema (otra fila vieja)
 *    se refresca con un aviso, pero respeta las 24 h si tiene alguna de ellas.
 * 3. Con más de 30 días de vigencia no se refresca, salvo con `force`. Sin vencimiento guardado, o
 *    con uno estimado (`meta.tokenExpiryEstimated`: token del panel aún sin refrescar), sí: el
 *    token pudo generarse días antes de conectarlo, así que se refresca en cuanto pasan las 24 h.
 * 4. Refresca y guarda el token nuevo (el repositorio lo cifra), el vencimiento y, en `meta`,
 *    `tokenRefreshedAt` y `tokenExpiryEstimated: false`. Los permisos no cambian (el refresco no
 *    los devuelve: con el token del panel siguen en `null`).
 * Errores: un 190 (`IG_AUTH_INVALID`) deja la cuenta en `expired` y se informa como resultado (con
 * la cuenta releída; si guardar el estado falla, va la cuenta sin cambiar y un aviso);
 * credenciales ilegibles (`CREDENTIALS_UNREADABLE`) la dejan en `error` y suben; cualquier otro
 * (red, cupo, base) sube **sin cambiar la cuenta**.
 */
async function refreshInstagram(
  deps: RefreshAccountTokensDeps,
  account: PlatformAccount,
  { force, signal }: RefreshOptions,
): Promise<TokenRefreshResult> {
  const now = (deps.now ?? (() => new Date()))();
  const warn = (code: string) => deps.onWarning?.({ accountId: account.id, code });
  const markAs = async (to: "expired" | "error") => {
    try {
      // Cambió, o ya no estaba `connected` (una desconexión en paralelo): se relee lo que quedó.
      await deps.platformAccounts.changeStatus(account.id, "connected", to);
      return (await deps.platformAccounts.get(account.id)) ?? account;
    } catch {
      warn("ACCOUNT_STATUS_NOT_SAVED");
      return account;
    }
  };

  const expiresAt = account.tokenExpiresAt;
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return { outcome: "expired", reason: "token_expired", account: await markAs("expired") };
  }

  const meta = instagramAccountMetaSchema.safeParse(account.meta);
  if (!meta.success) warn("ACCOUNT_META_UNREADABLE");
  const lastRefresh = lastRefreshOf(account.meta);
  const minAgeAt =
    lastRefresh === null ? null : new Date(lastRefresh.getTime() + TOKEN_REFRESH_MIN_AGE_MS);
  if (minAgeAt !== null && now.getTime() < minAgeAt.getTime()) {
    return { outcome: "skipped", reason: "too_recent", account, refreshableAt: minAgeAt };
  }
  const estimated = meta.success && meta.data.tokenExpiryEstimated;
  if (!force && expiresAt !== null && !estimated) {
    const windowAt = new Date(expiresAt.getTime() - TOKEN_REFRESH_WINDOW_MS);
    if (now.getTime() < windowAt.getTime()) {
      return { outcome: "skipped", reason: "not_due", account, refreshableAt: windowAt };
    }
  }

  let accessToken: string;
  try {
    ({ accessToken } = await deps.platformAccounts.getCredentials(account.id));
  } catch (error) {
    if (isAppError(error) && error.code === "CREDENTIALS_UNREADABLE") await markAs("error");
    throw error;
  }
  let token: Awaited<ReturnType<InstagramAuth["refresh"]>>;
  try {
    token = await deps.instagram.refresh(accessToken, signal === undefined ? {} : { signal });
  } catch (error) {
    if (isAppError(error) && error.code === "IG_AUTH_INVALID") {
      return { outcome: "expired", reason: "token_rejected", account: await markAs("expired") };
    }
    throw error;
  }
  const refreshed = await deps.platformAccounts.updateToken(account.id, {
    credentials: { accessToken: token.accessToken },
    tokenExpiresAt: token.expiresAt,
    meta: { tokenRefreshedAt: now.toISOString(), tokenExpiryEstimated: false },
  });
  return { outcome: "refreshed", account: refreshed };
}
