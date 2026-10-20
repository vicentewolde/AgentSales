import type { AbortSignalLike } from "../abort.js";

/**
 * Lo que entrega LinkedIn al canjear el código (`linkedin.md` §3.1): el token de acceso (secreto:
 * nunca va a un log ni a un error), cuándo vence (60 días; sin refresco para una app self-serve) y
 * los permisos concedidos (`scope`), o `null` si no vinieron.
 */
export type LinkedInToken = {
  accessToken: string;
  expiresAt: Date;
  scopes: string[] | null;
};

/** El miembro detrás del token (`GET /v2/userinfo`, OpenID Connect): su id (`sub`) y su nombre. */
export type LinkedInMember = {
  memberId: string;
  name: string;
};

/**
 * OAuth del perfil personal de LinkedIn (spec F9 §4.6 y §4.7, F9-T15; `linkedin.md` §3): lo
 * implementa `createLinkedInAuth` de `@agentsales/publishers/linkedin` con el par de la app
 * (`LINKEDIN_CLIENT_ID` y `LINKEDIN_CLIENT_SECRET`) y la dirección de retorno
 * (`LINKEDIN_REDIRECT_URI`). Los errores son `AppError` `LINKEDIN_*` y nunca llevan el código, el
 * token ni el secret: `LINKEDIN_AUTH_INVALID` (código vencido, usado o de otra dirección; token
 * rechazado), `LINKEDIN_APP_CREDENTIALS_INVALID` (el par de la app), `LINKEDIN_UNAVAILABLE` y
 * `LINKEDIN_RATE_LIMITED` (reintentables), `LINKEDIN_ABORTED` y `LINKEDIN_UNEXPECTED_RESPONSE`.
 */
export interface LinkedInAuth {
  /** La URL de autorización con el `state` firmado y los permisos `openid profile w_member_social`. */
  authorizeUrl(state: string): string;
  /** Canjea el código (dura 30 minutos y sirve una vez) por el token de acceso. */
  exchangeCode(code: string, options?: { signal?: AbortSignalLike }): Promise<LinkedInToken>;
  /** El miembro del token: solo lee (vale en `dry-run`, ADR-0016). */
  me(accessToken: string, options?: { signal?: AbortSignalLike }): Promise<LinkedInMember>;
}
