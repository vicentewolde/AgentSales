import { z } from "zod";
import type { AbortSignalLike } from "../abort.js";
import { ALL_SCOPE } from "../access.js";
import type { Platform } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  accountTokenNeverExpires,
  hasAccessToken,
  instagramAccountMetaSchema,
  type PlatformAccount,
  type TokenCredentials,
  tokenCredentialsOf,
} from "../platform-account.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PlatformTokenRefresher } from "../ports/token-refresher.js";
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  accessTokenStillFresh,
  ensureRotatingAccessToken,
  refreshMercadoLibreToken,
} from "./ensure-access-token.js";

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

/**
 * Las plataformas con refresco, cada una con su política. X entra con su cliente (F9-T16) con la
 * política del token que rota (`ensureRotatingAccessToken`, F9-T06, la misma que al publicar), y
 * TikTok con la misma (F9-T26).
 */
const REFRESHABLE_PLATFORMS: ReadonlySet<Platform> = new Set([
  "instagram",
  "portal_inmobiliario",
  "x",
  "tiktok",
]);

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
  /**
   * La renovación de las plataformas con token que rota (X, F9-T16, y TikTok, F9-T26; ADR-0029
   * punto 11): la misma que usa el intento. Sin la de una plataforma (falta su par de la app), una
   * cuenta suya a la que le toca es `TOKEN_REFRESH_NOT_CONFIGURED`, sin llamar ni cambiarla.
   */
  refreshers?: Readonly<Partial<Record<Platform, PlatformTokenRefresher>>>;
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
 *   vencimiento no es una estimación; en Mercado Libre, se refrescó (o conectó) hace menos de 7 días;
 * - `never_expires` (F9-T02): la `meta` marca que el token no vence (`tokenNeverExpires`, un system
 *   user de Meta); nunca se refresca, tampoco con `force`, y no tiene `refreshableAt`.
 */
export const TOKEN_REFRESH_SKIP_REASONS = ["too_recent", "not_due", "never_expires"] as const;
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
      /** Desde cuándo se refrescaría; `null` con `never_expires` (nunca). */
      refreshableAt: Date | null;
    }
  | { outcome: "expired"; reason: TokenExpiredReason; account: PlatformAccount };

type RefreshOptions = { force: boolean; signal: AbortSignalLike | undefined };

/**
 * Refresca el token de **una** cuenta con la política de su plataforma (spec F3 §4.6 y F4 §4.3):
 * lo usan el refresco a pedido de la API (`POST /accounts/:id/refresh`, síncrono) y el lote del job
 * `tokens.refresh`. La cuenta tiene que existir (`ACCOUNT_NOT_FOUND`), ser de Instagram, de Portal,
 * de X o de TikTok (`ACCOUNT_REFRESH_UNSUPPORTED`) y estar `connected` (`ACCOUNT_NOT_CONNECTED`). Las
 * reglas de cada plataforma están en `refreshInstagram`, `refreshMercadoLibre` y `refreshRotating`
 * (X, F9-T16, y TikTok, F9-T26). Ningún resultado ni error lleva el token.
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
      `El acceso de ${account.platform} no se refresca: solo el de Instagram, el de Mercado Libre, el de X y el de TikTok`,
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
function refreshConnected(
  deps: RefreshAccountTokensDeps,
  account: PlatformAccount,
  options: RefreshOptions,
): Promise<TokenRefreshResult> {
  // Antes de descifrar y de llamar a la plataforma: un token que no vence (un system user de Meta)
  // no se manda al refresco, que podría rechazarlo y dejar la cuenta vencida.
  if (accountTokenNeverExpires(account)) {
    return Promise.resolve({
      outcome: "skipped",
      reason: "never_expires",
      account,
      refreshableAt: null,
    });
  }
  switch (account.platform) {
    case "instagram":
      return refreshInstagram(deps, account, options);
    case "portal_inmobiliario":
      return refreshMercadoLibre(deps, account, options);
    case "x":
    case "tiktok":
      return refreshRotating(deps, account, options);
    case "fb_marketplace":
    // F9: LinkedIn no tiene refresco y Discord no vence.
    case "linkedin":
    case "discord":
      // `REFRESHABLE_PLATFORMS` ya la dejó fuera; el `switch` obliga a decidir al sumar otra.
      throw new AppError(
        "ACCOUNT_REFRESH_UNSUPPORTED",
        `El acceso de ${account.platform} no se refresca`,
        { details: { accountId: account.id, platform: account.platform } },
      );
  }
}

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
  /**
   * Las que no se empezaron porque se acabó el tiempo del lote (F8-T12, `budgetMs`): van en la
   * siguiente corrida.
   */
  deferred: string[];
};

/**
 * El lote del job `tokens.refresh` (al arrancar el worker y una vez al día): refresca, sin `force`,
 * las cuentas de Instagram y de Portal conectadas a las que les toca según su política. Una cuenta
 * que falla no corta las demás: sin el par de Mercado Libre, las de Portal a las que les toca
 * quedan en `failed` (`MERCADOLIBRE_NOT_CONFIGURED`, no reintentable) sin cambiar, y el lote sigue.
 * Con la señal disparada (apagado) no empieza otra cuenta. Con `budgetMs` (F8-T12, spec F8 §4.10),
 * pasado ese tiempo desde que empezó no empieza otra: las que faltan quedan en `deferred` para la
 * siguiente corrida (así un lote largo no se cruza con el reintento de un job que venció).
 */
export async function refreshAccountTokens(
  deps: RefreshAccountTokensDeps,
  { signal, budgetMs }: { signal?: AbortSignalLike; budgetMs?: number } = {},
): Promise<TokenRefreshReport> {
  const report: TokenRefreshReport = {
    refreshed: [],
    expired: [],
    skipped: 0,
    failed: [],
    deferred: [],
  };
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  const accounts = (await deps.platformAccounts.list(ALL_SCOPE)).filter(
    (account) =>
      REFRESHABLE_PLATFORMS.has(account.platform) &&
      account.status === "connected" &&
      account.hasCredentials,
  );
  for (const [index, account] of accounts.entries()) {
    if (signal?.aborted) break;
    if (budgetMs !== undefined && now().getTime() - startedAt >= budgetMs) {
      report.deferred = accounts.slice(index).map((pending) => pending.id);
      break;
    }
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
 *    si es `null`, `meta.connectedAt`; sin ninguna de las dos, refresca; una fecha futura, por un
 *    reloj descuadrado, espera como mucho 7 días desde ahora). Si no, `skipped`
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
    const at = now().getTime();
    // Una fecha futura (reloj descuadrado) no la deja sin refrescar para siempre.
    const dueAt = Math.min(last.getTime(), at) + MERCADOLIBRE_REFRESH_AGE_MS;
    return at < dueAt ? new Date(dueAt) : null;
  };

  if (!force) {
    const refreshableAt = notDueUntil(account);
    if (refreshableAt !== null) {
      return { outcome: "skipped", reason: "not_due", account, refreshableAt };
    }
  }
  // Lo que respondió la regla dentro del candado (un objeto: TypeScript no sigue una asignación
  // hecha dentro de `shouldRefresh`).
  const inside: { refreshableAt: Date | null } = { refreshableAt: null };
  try {
    const result = await refreshMercadoLibreToken(deps, account.id, {
      shouldRefresh: ({ account: current }) => {
        if (force) return true;
        inside.refreshableAt = notDueUntil(current);
        return inside.refreshableAt === null;
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.outcome === "refreshed") return { outcome: "refreshed", account: result.account };
    // Otro la refrescó mientras se esperaba el candado. `kept` solo sale de una regla que dijo "no
    // toca", que dejó `refreshableAt` (el `?? now()` es solo para el tipo).
    return {
      outcome: "skipped",
      reason: "not_due",
      account: result.account,
      refreshableAt: inside.refreshableAt ?? now(),
    };
  } catch (error) {
    if (isAppError(error) && error.code === "ML_AUTH_INVALID") {
      return { outcome: "expired", reason: "token_rejected", account: await reread(deps, account) };
    }
    throw error;
  }
}

/** Solo el reloj del token que rota, leído aparte del resto de `meta`. */
const rotatingClockSchema = z.object({
  tokenRefreshedAt: z.iso.datetime().nullish().catch(undefined),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

/**
 * X (F9-T16; ADR-0029 punto 11), con `ensureRotatingAccessToken`, **la misma función** del intento:
 * el candado de credenciales y la regla "se vuelve a mirar dentro" hacen que el lote y un intento
 * nunca renueven a la vez con el mismo refresh token.
 * 1. Sin `force`, solo si al access token le quedan 30 min o menos (`meta.accessTokenExpiresAt`;
 *    sin la fecha, toca). Como vive unas 2 h, el lote diario casi siempre lo renueva: así el
 *    refresh token se usa al menos una vez al día y no cae por desuso (su duración real no está
 *    verificada, `x.md` §3.1). Si no toca, `skipped` (`not_due`) sin tomar el candado.
 * 2. Con `force`, se pide renovar el token guardado como si X lo hubiera rechazado (`rejectedToken`):
 *    dentro del candado se renueva solo si sigue siendo ese (otro proceso pudo renovarlo recién).
 * 3. `refreshed` si la cuenta quedó con otro `tokenRefreshedAt`; si no (otro la renovó mientras se
 *    esperaba el candado, o ya no tocaba), `skipped`.
 * Un refresh token rechazado (`invalid_grant`, `TOKEN_REFRESH_REJECTED`; la cuenta ya quedó
 * `expired` dentro del candado) es un resultado (`expired`, `token_rejected`). Los demás suben: sin
 * la app de X, `TOKEN_REFRESH_NOT_CONFIGURED`; la red, el tope de 10 s o el candado ocupado, sin
 * cambiar la cuenta; credenciales ilegibles o sin `refreshToken`, con la cuenta en `error`.
 */
async function refreshRotating(
  deps: RefreshAccountTokensDeps,
  account: PlatformAccount,
  { force, signal }: RefreshOptions,
): Promise<TokenRefreshResult> {
  const now = deps.now ?? (() => new Date());
  if (!force && accessTokenStillFresh(account, now())) {
    const { accessTokenExpiresAt } = rotatingClockSchema.parse(account.meta);
    return {
      outcome: "skipped",
      reason: "not_due",
      account,
      refreshableAt: new Date(
        new Date(accessTokenExpiresAt ?? now().toISOString()).getTime() -
          ACCESS_TOKEN_REFRESH_MARGIN_MS,
      ),
    };
  }
  const before = rotatingClockSchema.parse(account.meta).tokenRefreshedAt ?? null;
  const rotating = {
    platformAccounts: deps.platformAccounts,
    refreshers: deps.refreshers ?? {},
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
  };
  try {
    let rejectedToken: string | undefined;
    if (force) {
      // Si no se leen, `ensureRotatingAccessToken` las vuelve a leer y deja la cuenta en `error`.
      const stored = await deps.platformAccounts.getCredentials(account.id).catch(() => null);
      rejectedToken = stored !== null && hasAccessToken(stored) ? stored.accessToken : undefined;
    }
    await ensureRotatingAccessToken(rotating, account.id, {
      ...(rejectedToken === undefined ? {} : { rejectedToken }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (isAppError(error) && error.code === "TOKEN_REFRESH_REJECTED") {
      return { outcome: "expired", reason: "token_rejected", account: await reread(deps, account) };
    }
    throw error;
  }
  const after = await reread(deps, account);
  const clock = rotatingClockSchema.parse(after.meta);
  if ((clock.tokenRefreshedAt ?? null) !== before) return { outcome: "refreshed", account: after };
  return {
    outcome: "skipped",
    reason: "not_due",
    account: after,
    refreshableAt: new Date(
      new Date(clock.accessTokenExpiresAt ?? now().toISOString()).getTime() -
        ACCESS_TOKEN_REFRESH_MARGIN_MS,
    ),
  };
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

  let stored: TokenCredentials;
  try {
    stored = tokenCredentialsOf(await deps.platformAccounts.getCredentials(account.id));
  } catch (error) {
    if (isAppError(error) && error.code === "CREDENTIALS_UNREADABLE") await markAs("error");
    throw error;
  }
  let token: Awaited<ReturnType<InstagramAuth["refresh"]>>;
  try {
    token = await deps.instagram.refresh(
      stored.accessToken,
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (isAppError(error) && error.code === "IG_AUTH_INVALID") {
      return { outcome: "expired", reason: "token_rejected", account: await markAs("expired") };
    }
    throw error;
  }
  const refreshed = await deps.platformAccounts.updateToken(account.id, {
    // Solo cambia el token: lo demás que guardaban las credenciales se conserva.
    credentials: { ...stored, accessToken: token.accessToken },
    tokenExpiresAt: token.expiresAt,
    meta: { tokenRefreshedAt: now.toISOString(), tokenExpiryEstimated: false },
  });
  return { outcome: "refreshed", account: refreshed };
}
