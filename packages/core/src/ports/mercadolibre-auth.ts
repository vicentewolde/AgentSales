import type { AbortSignalLike } from "../abort.js";
import { isAppError } from "../errors.js";

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
};

/**
 * El canje del código. `refreshToken` (`TG-…`) es `null` si Mercado Libre no lo entregó (sin el
 * scope `offline_access`): quien conecta lo informa con los permisos (spec F4 §4.2, T06).
 */
export type MercadoLibreCodeExchange = MercadoLibreTokens & {
  refreshToken: string | null;
  /** El usuario dueño de los tokens (`user_id`); T06 lo compara con el de `/users/me`. */
  userId: string;
};

/**
 * El refresco: siempre trae el `refresh_token` nuevo, porque el anterior ya no sirve (es de un solo
 * uso, ADR-0015); sin él, `ML_UNEXPECTED_RESPONSE`. Como Mercado Libre ya rotó el par, lo demás no
 * lo descarta: sin `expires_in` válido, el vencimiento es conservador (1 h), y `userId` es `null`
 * si no vino (T07 lo compara con la cuenta cuando viene).
 */
export type MercadoLibreRefresh = MercadoLibreTokens & {
  refreshToken: string;
  userId: string | null;
};

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
 * errores son `AppError` `ML_*` (spec F4 §4.8): nunca llevan tokens, el secret ni el código. En
 * todos los métodos que llaman: `ML_UNAVAILABLE` (red, tope de tiempo o 5xx) y `ML_RATE_LIMITED`
 * son reintentables, `ML_ABORTED` es la señal, y `ML_UNEXPECTED_RESPONSE` una respuesta con otra
 * forma.
 */
export interface MercadoLibreAuth {
  /** URL de autorización de Mercado Libre Chile, con el `state` firmado (sin PKCE, D3). */
  authorizeUrl(state: string): string;
  /**
   * Canjea el código (sirve una vez y se canjea de inmediato) por el par de tokens. Errores:
   * `ML_AUTH_INVALID` (código vencido, usado o de otra dirección de retorno: conectar de nuevo),
   * `ML_APP_CREDENTIALS_INVALID` (el par de la app) y `ML_PERMISSION_DENIED` (app bloqueada o un
   * colaborador en vez de la cuenta administradora).
   */
  exchangeCode(
    code: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<MercadoLibreCodeExchange>;
  /**
   * Refresca con el último `refresh_token`: Mercado Libre lo invalida y entrega otro, que hay que
   * guardar antes de usar el `access_token` nuevo (ADR-0015). Con un tope de 10 s, porque corre
   * dentro del candado de la cuenta. Errores: `ML_AUTH_INVALID` (`invalid_grant`, 401 o un token
   * guardado mal formado: la cuenta pasa a `expired`), `ML_APP_CREDENTIALS_INVALID` y
   * `ML_PERMISSION_DENIED` (la cuenta no cambia).
   */
  refresh(
    refreshToken: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<MercadoLibreRefresh>;
  /**
   * El usuario del token (`GET /users/me`). Un token rechazado es `ML_AUTH_INVALID` con
   * `httpStatus: 401` (`isMercadoLibreTokenRejected`).
   */
  me(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<MercadoLibreUser>;
}

/**
 * El motivo de un 401 que se repitió después de refrescar una vez (F4-T09): ya no se refresca de
 * nuevo, y quien lo recibe deja la cuenta `expired`.
 */
export const MERCADOLIBRE_REJECTED_AFTER_REFRESH = "rejected_after_refresh";

/**
 * ¿Mercado Libre rechazó el `access_token` en una llamada a un recurso (401)? Entonces se pide otro
 * token con el rechazado (`rejectedToken`) y se repite una vez; si vuelve a pasar, el error sube
 * marcado (`MERCADOLIBRE_REJECTED_AFTER_REFRESH`), esta función ya no lo reconoce y la cuenta pasa a
 * `expired` (ADR-0015, seguimiento de F4-T03). No incluye `invalid_grant` ni un token mal formado:
 * refrescar no los arregla.
 */
export function isMercadoLibreTokenRejected(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.code === "ML_AUTH_INVALID" &&
    error.details?.httpStatus === 401 &&
    error.details.reason !== MERCADOLIBRE_REJECTED_AFTER_REFRESH
  );
}

/**
 * ¿Es el 401 que se repitió después de refrescar una vez (`MERCADOLIBRE_REJECTED_AFTER_REFRESH`)?
 * Quien lo recibe decide: el intento (T16), las operaciones y el sync (T17) dejan la cuenta
 * `expired`; `ml:smoke` solo lo informa (F4-T10).
 */
export function isMercadoLibreRejectedAfterRefresh(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.code === "ML_AUTH_INVALID" &&
    error.details?.reason === MERCADOLIBRE_REJECTED_AFTER_REFRESH
  );
}
