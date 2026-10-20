import { z } from "zod";
import type { PlatformAccount } from "../platform-account.js";

// La cuenta de X (spec F9 §4.6, §4.7 y §4.12; F9-T16; `docs/integraciones/x.md`). Sin secretos:
// el par de tokens va cifrado en las credenciales (`{ accessToken, refreshToken }`).

/** El tope de gasto de una cuenta de X si el administrador no fijó otro (spec F9 §4.12, P2). */
export const X_DEFAULT_SPEND_LIMIT_USD = 10;

/** El tope más alto que se acepta al fijarlo (una cifra mayor es casi seguro un error de tipeo). */
export const X_MAX_SPEND_LIMIT_USD = 1000;

/** Un tope de gasto: dólares con hasta 4 decimales (`numeric(10,4)` de `cost_usd`), de 0 a 1.000. */
export const xSpendLimitSchema = z
  .number()
  .finite()
  .min(0)
  .max(X_MAX_SPEND_LIMIT_USD)
  .transform((value) => Math.round(value * 10_000) / 10_000);

/**
 * `meta` de una cuenta de X (F9-T16), sin secretos:
 * - `userId` y `username`: los de `GET /2/users/me` al conectar; `username` arma el enlace del post
 *   (`https://x.com/<username>/status/<id>`).
 * - `scopes`: los que entregó el canje (deben incluir `tweet.write`, `media.write` y
 *   `offline.access`).
 * - `accessTokenExpiresAt`: vence el access token (unas 2 h); lo lee `ensureRotatingAccessToken`.
 * - `tokenRefreshedAt`: el último refresco (`null` hasta el primero).
 * - `spendLimitUsd`: el tope de gasto del mes (spec F9 §4.12); sin él, `X_DEFAULT_SPEND_LIMIT_USD`.
 * - `mode: "manual"` (ADR-0029 punto 9) la deja a mano.
 */
export const xAccountMetaSchema = z.object({
  mode: z.enum(["api", "manual"]).optional(),
  userId: z.string().regex(/^\d{1,30}$/),
  username: z.string().regex(/^\w{1,50}$/),
  scopes: z.array(z.string()),
  connectedAt: z.iso.datetime(),
  tokenRefreshedAt: z.iso.datetime().nullable(),
  accessTokenExpiresAt: z.iso.datetime(),
  spendLimitUsd: xSpendLimitSchema.optional(),
});
export type XAccountMeta = z.infer<typeof xAccountMetaSchema>;

/** Solo el tope, leído aparte del resto de `meta`: una `meta` incompleta usa el de por defecto. */
const spendLimitOnly = z.object({ spendLimitUsd: xSpendLimitSchema.optional().catch(undefined) });

/** El tope de gasto del mes de una cuenta de X: el de su `meta` o US$10. */
export function xSpendLimitOf(account: Pick<PlatformAccount, "meta">): number {
  return spendLimitOnly.parse(account.meta).spendLimitUsd ?? X_DEFAULT_SPEND_LIMIT_USD;
}

/** Los permisos que pide el OAuth de X (`x.md` §3.1): publicar, subir medios y renovar el acceso. */
export const X_OAUTH_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
] as const;

/** Los permisos sin los que la cuenta no sirve para publicar: conectar sin ellos falla. */
export const X_REQUIRED_SCOPES = ["tweet.write", "media.write", "offline.access"] as const;
