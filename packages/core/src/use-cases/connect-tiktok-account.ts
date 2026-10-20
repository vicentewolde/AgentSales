import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { PlatformAccount } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { TikTokAuth } from "../ports/tiktok-auth.js";
import {
  TIKTOK_PROFILE_SCOPE,
  TIKTOK_REFRESH_TOKEN_DAYS,
  TIKTOK_UPLOAD_SCOPE,
  type TikTokAccountMeta,
  tiktokAccountMetaSchema,
} from "../tiktok/account.js";
import { requireBroker } from "./connect-account.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ConnectTikTokAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected">;
  /** Login Kit: el canje del código y la cuenta del token. */
  tiktok: Pick<TikTokAuth, "exchangeCode" | "user">;
  now?: () => Date;
};

/**
 * El nombre a la vista sin `user.info.basic`: el principio del `open_id` (no es secreto, pero es
 * largo).
 */
const fallbackName = (openId: string) => `TikTok ${openId.slice(0, 8)}`;

/**
 * Conecta la cuenta de TikTok de un corredor o marca con el código de Login Kit (spec F9 §4.7,
 * F9-T26). Quien llama ya verificó el `state` (firmado, de la plataforma, vigente y de un solo uso):
 * 1. el corredor (`broker`, su slug) tiene que existir (`BROKER_NOT_FOUND`);
 * 2. canjea el código y **exige** `video.upload` (`TIKTOK_PERMISSION_DENIED`: el usuario pudo
 *    desmarcarlo);
 * 3. con `user.info.basic`, lee la cuenta: tiene que ser la del canje (`TIKTOK_UNEXPECTED_RESPONSE`);
 *    sin él, se nombra por el principio de su `open_id`;
 * 4. la guarda conectada con el par cifrado por el repositorio (`{ accessToken, refreshToken }`),
 *    `token_expires_at` = el vencimiento del `refresh_token` (365 días si TikTok no lo informa) y el
 *    del `access_token` en `meta`. Otra cuenta de TikTok del corredor queda desconectada en el mismo
 *    paso; reconectar la misma actualiza su fila.
 * Los errores de TikTok (`TIKTOK_*`) pasan tal cual; ninguno lleva el código ni los tokens.
 */
export async function connectTikTokAccount(
  deps: ConnectTikTokAccountDeps,
  { broker: slug, code, signal }: { broker: string; code: string; signal?: AbortSignalLike },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const now = deps.now ?? (() => new Date());
  const options = signal === undefined ? {} : { signal };

  const exchanged = await deps.tiktok.exchangeCode(code, options);
  if (!exchanged.scopes.includes(TIKTOK_UPLOAD_SCOPE)) {
    throw new AppError(
      "TIKTOK_PERMISSION_DENIED",
      "La cuenta no dio el permiso de subir videos a TikTok: conecta de nuevo y deja marcado ese permiso",
      { details: { missing: [TIKTOK_UPLOAD_SCOPE], scopes: exchanged.scopes } },
    );
  }

  let displayName = fallbackName(exchanged.openId);
  if (exchanged.scopes.includes(TIKTOK_PROFILE_SCOPE)) {
    const user = await deps.tiktok.user(exchanged.accessToken, options);
    if (user.openId !== exchanged.openId) {
      throw new AppError(
        "TIKTOK_UNEXPECTED_RESPONSE",
        "TikTok respondió por otra cuenta al conectar: conecta de nuevo",
        { details: { call: "user", reason: "user_mismatch" } },
      );
    }
    if (user.displayName.trim() !== "") displayName = user.displayName.trim();
  }

  const connectedAt = now();
  const meta: TikTokAccountMeta = tiktokAccountMetaSchema.parse({
    openId: exchanged.openId,
    scopes: exchanged.scopes,
    connectedAt: connectedAt.toISOString(),
    tokenRefreshedAt: null,
    accessTokenExpiresAt: exchanged.accessTokenExpiresAt.toISOString(),
  });
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "tiktok",
      externalAccountId: exchanged.openId,
      displayName,
      tokenExpiresAt:
        exchanged.refreshTokenExpiresAt ??
        new Date(connectedAt.getTime() + TIKTOK_REFRESH_TOKEN_DAYS * DAY_MS),
      meta,
      credentials: { accessToken: exchanged.accessToken, refreshToken: exchanged.refreshToken },
    },
    { revokeOthers: true },
  );
}
