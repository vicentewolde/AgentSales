import type { AbortSignalLike } from "../abort.js";
import type { PlatformTokenRefresher } from "./token-refresher.js";

/**
 * Lo que entrega TikTok al canjear el código (Login Kit, `tiktok.md` §4). Secretos: los tokens
 * nunca van a un log ni a un error.
 */
export type TikTokCodeExchange = {
  /** Vale 24 h (`expires_in`). */
  accessToken: string;
  /** Vale 365 días (`refresh_expires_in`) y puede rotar al renovar: se guarda el último. */
  refreshToken: string;
  /** El id de la cuenta para esta app (`open_id`). */
  openId: string;
  /** Los permisos concedidos (`scope`, separados por comas). */
  scopes: string[];
  accessTokenExpiresAt: Date;
  /** Cuándo vence el `refreshToken`, si TikTok lo informa. */
  refreshTokenExpiresAt: Date | null;
};

/** La cuenta detrás de un token (`/v2/user/info/`, con `user.info.basic`). */
export type TikTokUser = { openId: string; displayName: string };

/**
 * OAuth de TikTok (Login Kit web, spec F9 §4.7, F9-T26): lo implementa `createTikTokAuth` de
 * `@agentsales/publishers/tiktok`, con el par de la app (`TIKTOK_CLIENT_KEY` y
 * `TIKTOK_CLIENT_SECRET`) y la dirección de retorno (`TIKTOK_REDIRECT_URI`). Es además la
 * renovación del token que rota (`PlatformTokenRefresher`, ADR-0029 punto 11), con su propio tope
 * de 10 s. Los errores son `AppError` `TIKTOK_*`: nunca llevan tokens, el secret ni el código.
 */
export interface TikTokAuth extends PlatformTokenRefresher {
  /** La URL de autorización, con el `state` firmado y los permisos de `TIKTOK_SCOPES`. */
  authorizeUrl(state: string): string;
  /**
   * Canjea el código (sirve una vez). `TIKTOK_AUTH_INVALID` si TikTok no lo acepta (venció, se usó
   * o la dirección de retorno no coincide): se conecta de nuevo.
   */
  exchangeCode(code: string, options?: { signal?: AbortSignalLike }): Promise<TikTokCodeExchange>;
  /** La cuenta del token (`open_id` y nombre a la vista). */
  user(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<TikTokUser>;
}
