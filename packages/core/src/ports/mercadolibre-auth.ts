import type { AbortSignalLike } from "../abort.js";

/**
 * Lo que entrega Mercado Libre al canjear un código o refrescar (nota §3.1 y §3.2). Secretos: los
 * tokens nunca van a un log ni a un error.
 */
export type MercadoLibreTokens = {
  /** `APP_USR-…`: vale horas (`expires_in`, que se lee y no se fija en 6 h). */
  accessToken: string;
  /** Vencimiento del `access_token` (ahora + `expires_in`). */
  accessTokenExpiresAt: Date;
  /** Permisos concedidos (`scope`, separados por espacios): `offline_access`, `read`, `write`. */
  scopes: string[];
  /** El usuario dueño de los tokens (`user_id`). */
  userId: string;
};

/**
 * El canje del código. `refreshToken` (`TG-…`) es `null` si Mercado Libre no lo entregó (sin el
 * scope `offline_access`): quien conecta lo informa con los permisos (spec F4 §4.2, T06).
 */
export type MercadoLibreCodeExchange = MercadoLibreTokens & { refreshToken: string | null };

/**
 * El refresco: siempre trae el `refresh_token` nuevo, porque el anterior ya no sirve (es de un solo
 * uso, ADR-0015); sin él, `ML_UNEXPECTED_RESPONSE`.
 */
export type MercadoLibreRefresh = MercadoLibreTokens & { refreshToken: string };

/** El usuario detrás de un token (`GET /users/me`, nota §3.2). */
export type MercadoLibreUser = {
  userId: string;
  nickname: string;
  /** `MLC` en Chile; quien conecta rechaza otro (`ML_SITE_MISMATCH`, T06). */
  siteId: string;
  /** `normal`, `brand`, … (`null` si no vino). */
  userType: string | null;
  /** Etiquetas del usuario: `test_user` marca un usuario de prueba. */
  tags: string[];
};

/**
 * OAuth y usuario de Mercado Libre (spec F4 §4.2, ADR-0015): lo implementa
 * `createMercadoLibreAuth` de `@agentsales/publishers`, con el par de la app (`ML_APP_ID` y
 * `ML_CLIENT_SECRET`) y la dirección de retorno (`ML_REDIRECT_URI`) que le pasan las apps. Los
 * errores son `AppError` `ML_*` (spec F4 §4.8): nunca llevan tokens, el secret ni el código.
 */
export interface MercadoLibreAuth {
  /** URL de autorización de Mercado Libre Chile, con el `state` firmado (sin PKCE, D3). */
  authorizeUrl(state: string): string;
  /** Canjea el código (sirve una vez y se canjea de inmediato) por el par de tokens. */
  exchangeCode(
    code: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<MercadoLibreCodeExchange>;
  /**
   * Refresca con el último `refresh_token`: Mercado Libre lo invalida y entrega otro, que hay que
   * guardar antes de usar el `access_token` nuevo (ADR-0015). `invalid_grant` es `ML_AUTH_INVALID`.
   */
  refresh(
    refreshToken: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<MercadoLibreRefresh>;
  /** El usuario del token (`GET /users/me`). */
  me(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<MercadoLibreUser>;
}
