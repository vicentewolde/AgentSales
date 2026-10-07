import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import {
  MERCADOLIBRE_SITE_ID,
  type MercadoLibreAccountMeta,
  mercadoLibreAccountMetaSchema,
  type PlatformAccount,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { MercadoLibreAuth } from "../ports/mercadolibre-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { requireBroker } from "./connect-account.js";

/**
 * Horizonte del `refresh_token` de Mercado Libre: 6 meses desde la conexión o el último refresco
 * (nota §3.2). Es `token_expires_at` de la cuenta, siempre estimado (spec F4 §4.3).
 */
export const MERCADOLIBRE_REFRESH_TOKEN_DAYS = 180;

/** Permisos que exige conectar (spec F4 §4.2): refrescar sin el operador y publicar. */
export const MERCADOLIBRE_REQUIRED_SCOPES = ["offline_access", "write"] as const;

export type ConnectMercadoLibreAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected">;
  /** OAuth de Mercado Libre: el canje del código y `/users/me`. */
  mercadoLibre: Pick<MercadoLibreAuth, "exchangeCode" | "me">;
  now?: () => Date;
};

/**
 * Conecta la cuenta de Mercado Libre de un corredor con el código de la autorización (spec F4
 * §4.2). Quien llama ya verificó el `state` (firma, vencimiento, plataforma y corredor):
 * 1. el corredor (`broker`, su slug) tiene que existir (`BROKER_NOT_FOUND`);
 * 2. canjea el código de inmediato y **exige** `offline_access` y `write` (`ML_PERMISSION_DENIED`)
 *    y el `refresh_token` (`ML_UNEXPECTED_RESPONSE`: sin él la cuenta no se podría refrescar);
 * 3. lee `/users/me`: el usuario tiene que ser el mismo del canje (`ML_UNEXPECTED_RESPONSE`) y de
 *    Mercado Libre Chile (`ML_SITE_MISMATCH`);
 * 4. guarda la cuenta conectada con el par cifrado por el repositorio, `token_expires_at` a 6 meses
 *    (estimado) y el vencimiento del `access_token` en `meta`. Otra cuenta de Mercado Libre del
 *    corredor queda desconectada en el mismo paso; reconectar la misma actualiza su fila.
 * Los errores de Mercado Libre (`ML_*`) pasan tal cual; ninguno lleva el código ni los tokens.
 */
export async function connectMercadoLibreAccount(
  deps: ConnectMercadoLibreAccountDeps,
  { broker: slug, code, signal }: { broker: string; code: string; signal?: AbortSignalLike },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const now = deps.now ?? (() => new Date());
  const options = signal === undefined ? {} : { signal };

  const exchanged = await deps.mercadoLibre.exchangeCode(code, options);
  const missing = MERCADOLIBRE_REQUIRED_SCOPES.filter((scope) => !exchanged.scopes.includes(scope));
  if (missing.length > 0) {
    throw new AppError(
      "ML_PERMISSION_DENIED",
      "La cuenta no dio los permisos de la app (acceso prolongado y publicar): revisa los permisos de la app en developers.mercadolibre.cl y conecta de nuevo",
      { details: { missing, scopes: exchanged.scopes } },
    );
  }
  if (exchanged.refreshToken === null) {
    throw new AppError(
      "ML_UNEXPECTED_RESPONSE",
      "Mercado Libre no entregó el permiso para renovar el acceso: conecta de nuevo",
      { details: { call: "exchangeCode", reason: "refresh_token_missing" } },
    );
  }

  const user = await deps.mercadoLibre.me(exchanged.accessToken, options);
  if (user.userId !== exchanged.userId) {
    throw new AppError(
      "ML_UNEXPECTED_RESPONSE",
      "Mercado Libre respondió por otra cuenta al conectar: conecta de nuevo",
      { details: { call: "me", reason: "user_mismatch" } },
    );
  }
  if (user.siteId !== MERCADOLIBRE_SITE_ID) {
    throw new AppError(
      "ML_SITE_MISMATCH",
      `La cuenta es de otro país de Mercado Libre (${user.siteId}): conecta una cuenta de Mercado Libre Chile`,
      { details: { siteId: user.siteId } },
    );
  }

  const connectedAt = now();
  const meta: MercadoLibreAccountMeta = mercadoLibreAccountMetaSchema.parse({
    userId: user.userId,
    nickname: user.nickname,
    siteId: user.siteId,
    userType: user.userType,
    scopes: exchanged.scopes,
    testUser: user.tags.includes("test_user"),
    connectedAt: connectedAt.toISOString(),
    tokenRefreshedAt: null,
    accessTokenExpiresAt: exchanged.accessTokenExpiresAt.toISOString(),
    tokenExpiryEstimated: true,
  });
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "portal_inmobiliario",
      externalAccountId: user.userId,
      displayName: user.nickname,
      tokenExpiresAt: new Date(
        connectedAt.getTime() + MERCADOLIBRE_REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
      ),
      meta,
      credentials: { accessToken: exchanged.accessToken, refreshToken: exchanged.refreshToken },
    },
    { revokeOthers: true },
  );
}
