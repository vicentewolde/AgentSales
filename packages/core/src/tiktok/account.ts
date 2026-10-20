import { z } from "zod";

// TikTok (spec F9 §4.6 y §4.7, D16; F9-T26; `docs/integraciones/tiktok.md`): la cuenta conectada
// con Login Kit y lo que pide AgentSales. Solo **video como borrador** en la bandeja del creador
// (Content Posting API en modo *Upload*): sin auditoría de la app (por confirmar en la prueba S6).

/**
 * El permiso sin el que no se sube un borrador (`tiktok.md` §2): conectar lo exige. Es el de
 * *Upload* (la bandeja); el de publicar directo (`video.publish`) queda para el piloto.
 */
export const TIKTOK_UPLOAD_SCOPE = "video.upload";

/** El permiso que da el nombre a la vista (`/v2/user/info/`); sin él, la cuenta se nombra por su id. */
export const TIKTOK_PROFILE_SCOPE = "user.info.basic";

/** Lo que se pide al autorizar (separado por comas en la URL, `tiktok.md` §4). */
export const TIKTOK_SCOPES = [TIKTOK_PROFILE_SCOPE, TIKTOK_UPLOAD_SCOPE] as const;

/**
 * Vida del `refresh_token` si TikTok no la informa: 365 días (`tiktok.md` §4). Es el
 * `token_expires_at` de la cuenta (lo que hace falta para reconectar); el `access_token` (24 h) va
 * en `meta.accessTokenExpiresAt` y lo renueva `ensureRotatingAccessToken` (ADR-0029 punto 11).
 */
export const TIKTOK_REFRESH_TOKEN_DAYS = 365;

/**
 * `meta` de una cuenta de TikTok (spec F9 §4.7, F9-T26), sin secretos:
 * - `openId`: el id de la cuenta para esta app (`open_id`), también `external_account_id`;
 * - `scopes`: los que concedió (el usuario puede desmarcar algunos);
 * - `accessTokenExpiresAt`: vence el `access_token` (24 h); lo lee `ensureRotatingAccessToken`;
 * - `tokenRefreshedAt`: `null` hasta la primera renovación (la conexión entrega un par nuevo);
 * - `mode: "manual"` (ADR-0029 punto 9) la deja a mano, sin llamar a TikTok.
 */
export const tiktokAccountMetaSchema = z.object({
  mode: z.enum(["api", "manual"]).optional(),
  openId: z.string().min(1),
  scopes: z.array(z.string()),
  connectedAt: z.iso.datetime(),
  tokenRefreshedAt: z.iso.datetime().nullable(),
  accessTokenExpiresAt: z.iso.datetime(),
});
export type TikTokAccountMeta = z.infer<typeof tiktokAccountMetaSchema>;
