import type { AbortSignalLike } from "../abort.js";
import type { PlatformTokenRefresher, RefreshedTokens } from "./token-refresher.js";

/** Lo que entrega X al canjear el código (`x.md` §3.1). Secretos: nunca a un log ni a un error. */
export type XCodeExchange = RefreshedTokens & {
  /** Los permisos concedidos (`scope`, separados por espacios). */
  scopes: string[];
};

/** El usuario detrás de un token (`GET /2/users/me`, `x.md` §3.1). */
export type XUser = { id: string; username: string; name: string };

/**
 * OAuth 2.0 con PKCE de X (spec F9 §4.6 y §4.7, F9-T16): lo implementa `createXAuth` de
 * `@agentsales/publishers/x` con el par de la app (`X_CLIENT_ID` y `X_CLIENT_SECRET`, cliente
 * confidencial) y la dirección de retorno (`X_REDIRECT_URI`). Es también la renovación del token
 * (`PlatformTokenRefresher`: `ensureRotatingAccessToken` y el job `tokens.refresh`), con su propio
 * tope de 10 s; solo `invalid_grant` cuenta como rechazo. Los errores son `AppError` `X_*`: nunca
 * llevan tokens, el secret, el código ni el verificador.
 */
export interface XAuth extends PlatformTokenRefresher {
  /**
   * La URL de autorización de X con el `state` firmado y el `code_challenge` (S256) del verificador
   * que vive en la cookie firmada (nunca en la URL ni en la base).
   */
  authorizeUrl(state: string, codeChallenge: string): string;
  /** Canjea el código (vale 30 s) con su verificador. */
  exchangeCode(
    code: string,
    codeVerifier: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<XCodeExchange>;
  /** El usuario del token. */
  me(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<XUser>;
}
