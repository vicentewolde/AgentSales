import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { PlatformAccount } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { XAuth } from "../ports/x-auth.js";
import {
  X_REQUIRED_SCOPES,
  type XAccountMeta,
  xAccountMetaSchema,
  xSpendLimitSchema,
} from "../x/account.js";
import { requireBroker } from "./connect-account.js";

// Conectar X y fijar su tope de gasto (spec F9 §4.7 y §4.12, F9-T16).

export type ConnectXAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected" | "listByBroker">;
  x: Pick<XAuth, "exchangeCode" | "me">;
  now?: () => Date;
};

/**
 * Conecta la cuenta de X de un corredor o marca con el código de la vuelta del OAuth y su
 * verificador PKCE (que la ruta leyó de la cookie firmada): canjea (el código vale 30 s), exige los
 * permisos de publicar (`X_PERMISSION_MISSING` si falta `tweet.write`, `media.write` u
 * `offline.access`), lee el usuario (`GET /2/users/me`) y guarda la cuenta `connected` con el par
 * cifrado (`{ accessToken, refreshToken }`) y su `meta` (sin secretos). Conserva el tope de gasto y
 * el modo de una cuenta anterior de la marca con el mismo usuario (reconectar no los pierde), y
 * desconecta las demás de la marca en X (una por marca y plataforma, spec F9 D3).
 * `token_expires_at` queda `null`: X no informa cuándo vence el refresh token (`x.md` §3.1).
 */
export async function connectXAccount(
  deps: ConnectXAccountDeps,
  {
    broker: slug,
    code,
    codeVerifier,
    signal,
  }: { broker: string; code: string; codeVerifier: string; signal?: AbortSignalLike },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const options = signal === undefined ? {} : { signal };
  const tokens = await deps.x.exchangeCode(code, codeVerifier, options);
  const missing = X_REQUIRED_SCOPES.filter((scope) => !tokens.scopes.includes(scope));
  if (missing.length > 0) {
    throw new AppError(
      "X_PERMISSION_MISSING",
      `X no entregó todos los permisos (${missing.join(", ")}): vuelve a conectar y acepta todo lo que pide la pantalla de X`,
      { details: { missing } },
    );
  }
  const user = await deps.x.me(tokens.accessToken, options);
  const now = (deps.now ?? (() => new Date()))();
  const previous = (await deps.platformAccounts.listByBroker(broker.id, "x")).find(
    (account) => account.externalAccountId === user.id,
  );
  const kept =
    previous === undefined ? null : xAccountMetaSchema.partial().safeParse(previous.meta);
  const meta: XAccountMeta = xAccountMetaSchema.parse({
    ...(kept?.success === true && kept.data.mode !== undefined ? { mode: kept.data.mode } : {}),
    ...(kept?.success === true && kept.data.spendLimitUsd !== undefined
      ? { spendLimitUsd: kept.data.spendLimitUsd }
      : {}),
    userId: user.id,
    username: user.username,
    scopes: tokens.scopes,
    connectedAt: now.toISOString(),
    tokenRefreshedAt: null,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
  });
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "x",
      externalAccountId: user.id,
      displayName: `@${user.username}`,
      tokenExpiresAt: tokens.refreshTokenExpiresAt,
      meta,
      credentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    },
    { revokeOthers: true },
  );
}

export type SetXSpendLimitDeps = {
  platformAccounts: Pick<PlatformAccountRepository, "get" | "mergeMeta">;
};

/**
 * Fija el tope de gasto del mes de una cuenta de X (`meta.spendLimitUsd`, spec F9 §4.12; lo hace
 * el administrador): de US$0 a US$1.000, con hasta 4 decimales (`X_SPEND_LIMIT_INVALID` si no).
 * La cuenta tiene que existir (`ACCOUNT_NOT_FOUND`) y ser de X (`ACCOUNT_PLATFORM_INVALID`); puede
 * estar en cualquier estado (el tope se respeta al volver a conectarla con el mismo usuario).
 * El tope duro sigue estando en la consola de X: este es el de AgentSales, que no llama a X.
 */
export async function setXSpendLimit(
  deps: SetXSpendLimitDeps,
  { accountId, spendLimitUsd }: { accountId: string; spendLimitUsd: number },
): Promise<PlatformAccount> {
  const parsed = xSpendLimitSchema.safeParse(spendLimitUsd);
  if (!parsed.success) {
    throw new AppError(
      "X_SPEND_LIMIT_INVALID",
      "El tope de gasto va en dólares, de 0 a 1.000 (por ejemplo 10 o 2,5)",
    );
  }
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  if (account.platform !== "x") {
    throw new AppError("ACCOUNT_PLATFORM_INVALID", "El tope de gasto es solo de las cuentas de X", {
      details: { accountId, platform: account.platform },
    });
  }
  return deps.platformAccounts.mergeMeta(accountId, { spendLimitUsd: parsed.data });
}
