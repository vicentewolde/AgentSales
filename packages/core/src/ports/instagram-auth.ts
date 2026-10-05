import type { AbortSignalLike } from "../abort.js";

/** Un token largo de Instagram (60 días) y su vencimiento. Secreto: nunca va a un log ni a un error. */
export type InstagramToken = { accessToken: string; expiresAt: Date };

/** Lo que entrega el canje de un código: el token largo y los permisos que concedió la cuenta. */
export type InstagramCodeExchange = InstagramToken & { permissions: string[] };

/** La cuenta profesional detrás de un token (`/me`). */
export type InstagramProfile = {
  /** Id de la cuenta profesional (`user_id`): el que se usa para publicar. */
  userId: string;
  username: string;
  /** `BUSINESS` o `MEDIA_CREATOR`. */
  accountType: string;
};

/**
 * Instagram Login (spec F3 §4.6, ADR-0014): lo implementa `createInstagramAuth` de
 * `@agentsales/publishers`, con el par de la app de Instagram (`INSTAGRAM_APP_ID` y
 * `INSTAGRAM_APP_SECRET`) que le pasan las apps. Los errores son `AppError` `IG_*` (spec F3 §4.5):
 * nunca llevan tokens, el secret ni el código.
 */
export interface InstagramAuth {
  /** URL de la pantalla de permisos, con los scopes de F3 y el `state` firmado. */
  authorizeUrl(state: string): string;
  /**
   * Canjea el código de la redirección (con o sin el `#_` final, que se quita) por el token corto
   * y este por el largo. El código vale 1 hora y sirve una sola vez.
   */
  exchangeCode(
    code: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<InstagramCodeExchange>;
  /** Refresca un token largo vigente con al menos 24 h: devuelve uno nuevo de 60 días. */
  refresh(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<InstagramToken>;
  /** La cuenta del token (`/me?fields=user_id,username,account_type`). */
  me(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<InstagramProfile>;
}
