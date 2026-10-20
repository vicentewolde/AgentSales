import type { AbortSignalLike } from "../abort.js";

/** El par nuevo que entrega una plataforma al renovar (X, TikTok): el refresh token puede rotar. */
export type RefreshedTokens = {
  accessToken: string;
  refreshToken: string;
  /** Cuándo vence el `accessToken` (X: unas 2 h). Va a `meta.accessTokenExpiresAt`. */
  accessTokenExpiresAt: Date;
  /** Cuándo vence el `refreshToken`, si la plataforma lo informa: `token_expires_at` de la cuenta. */
  refreshTokenExpiresAt: Date | null;
};

/**
 * La renovación del token de una plataforma con access token de vida corta y refresh token que
 * rota (ADR-0029 punto 11, spec F9 §4.7): X (F9-T16) y TikTok (T26). Lo implementa el cliente de
 * cada plataforma en `packages/publishers`; `ensureRotatingAccessToken` (core) lo llama dentro del
 * candado de credenciales, una vez y con su propio tope de tiempo. Ningún error lleva un token.
 */
export interface PlatformTokenRefresher {
  refresh(refreshToken: string, options?: { signal?: AbortSignalLike }): Promise<RefreshedTokens>;
  /**
   * Si el error de `refresh` dice que la plataforma ya no acepta el refresh token (venció, se
   * revocó): la cuenta queda `expired` y hay que reconectarla. Cualquier otro error (la red, un
   * tope, un 5xx) sube sin cambiar la cuenta.
   */
  isRejected(error: unknown): boolean;
}
