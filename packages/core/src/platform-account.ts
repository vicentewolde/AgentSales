import { z } from "zod";
import { PLATFORM_ACCOUNT_STATUSES, PLATFORMS } from "./enums.js";
import { AppError } from "./errors.js";

/**
 * Cuenta conectada de un corredor en una plataforma (`platform_accounts`, spec F3 §4.6). La entidad
 * **nunca** lleva credenciales: se leen aparte, ya descifradas, con
 * `PlatformAccountRepository.getCredentials`, y solo quien publica o refresca las pide.
 */
export const platformAccountSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  platform: z.enum(PLATFORMS),
  /** Id de la cuenta en la plataforma (Instagram: el `user_id` de `/me`). */
  externalAccountId: z.string().min(1),
  /** Lo que ve el operador (Instagram: `@usuario`). */
  displayName: z.string(),
  status: z.enum(PLATFORM_ACCOUNT_STATUSES),
  tokenExpiresAt: z.date().nullable(),
  /** Datos propios de la plataforma, sin secretos (Instagram: tipo de cuenta, permisos, último refresco). */
  meta: z.record(z.string(), z.unknown()),
  /** Si hay credenciales guardadas (una cuenta desconectada no tiene). */
  hasCredentials: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PlatformAccount = z.infer<typeof platformAccountSchema>;

/**
 * El permiso de Instagram sin el que no se puede publicar: conectar una cuenta lo exige cuando se
 * conocen los permisos (spec F3 §4.6). Vive en core porque lo revisa `connectAccount` (T13).
 */
export const INSTAGRAM_PUBLISH_SCOPE = "instagram_business_content_publish";

/**
 * Credenciales de una cuenta, ya descifradas: solo viven en memoria, nunca van a un log, un error,
 * una respuesta HTTP ni a los datos de un job. Se guardan cifradas (`credentials_encrypted`).
 */
export const platformCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  /**
   * Mercado Libre (ADR-0015): el token que renueva el acceso. Sirve una sola vez y solo vale el
   * último, así que se refresca con el candado de la cuenta. Instagram no lo usa.
   */
  refreshToken: z.string().min(1).optional(),
});
export type PlatformCredentials = z.infer<typeof platformCredentialsSchema>;

/**
 * Valida las credenciales antes de guardarlas: `CREDENTIALS_INVALID` (no reintentable) si no
 * calzan. El error no lleva el valor recibido.
 */
export function checkCredentials(credentials: unknown): PlatformCredentials {
  const parsed = platformCredentialsSchema.safeParse(credentials);
  if (!parsed.success) {
    throw new AppError("CREDENTIALS_INVALID", "Las credenciales de la cuenta no son válidas");
  }
  return parsed.data;
}

/**
 * `meta` tal como queda guardada (jsonb): un objeto JSON, sin `undefined` ni fechas como `Date`.
 * La usan los dos repositorios para comportarse igual. `ACCOUNT_META_INVALID` si no es un objeto.
 */
export function normalizeAccountMeta(meta: unknown): Record<string, unknown> {
  const json: unknown = JSON.parse(JSON.stringify(meta ?? {}));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AppError("ACCOUNT_META_INVALID", "Los datos de la cuenta deben ser un objeto");
  }
  return json as Record<string, unknown>;
}

/**
 * `meta` de una cuenta de Instagram (spec F3 §4.6, T13): lo que muestra el panel y lo que lee el
 * refresco (T14). Con el token del panel de Meta (`connect-token`) no hay canje, así que los permisos
 * son `null` (desconocidos; nunca `[]`, que se leería como "ninguno"), `tokenRefreshedAt` es `null`
 * y el vencimiento es una estimación (`tokenExpiryEstimated`).
 */
export const instagramAccountMetaSchema = z.object({
  /** `BUSINESS` o `MEDIA_CREATOR`. */
  accountType: z.string(),
  permissions: z.array(z.string()).nullable(),
  connectedAt: z.iso.datetime(),
  tokenRefreshedAt: z.iso.datetime().nullable(),
  tokenExpiryEstimated: z.boolean(),
});
export type InstagramAccountMeta = z.infer<typeof instagramAccountMetaSchema>;

/** Sitio de Mercado Libre donde se publica (Chile): fijo, no es una variable (spec F4 §4.2). */
export const MERCADOLIBRE_SITE_ID = "MLC";

/**
 * Horizonte del `refresh_token` de Mercado Libre: 6 meses desde la conexión o el último refresco
 * (nota §3.2). Es `token_expires_at` de la cuenta, siempre estimado (spec F4 §4.3): lo fijan
 * conectar (T06) y cada refresco (T08).
 */
export const MERCADOLIBRE_REFRESH_TOKEN_DAYS = 180;

/**
 * `meta` de una cuenta de Mercado Libre (spec F4 §4.2 y §4.3, ADR-0015). No lleva secretos.
 * - `accessTokenExpiresAt`: vence el `access_token` (horas; ahora + `expires_in`). Lo lee
 *   `ensureAccessToken` para refrescar antes.
 * - `token_expires_at` de la cuenta es otra cosa: el horizonte estimado del `refresh_token`
 *   (último refresco + 6 meses), por eso `tokenExpiryEstimated` es `true`.
 * - `tokenRefreshedAt` es `null` hasta el primer refresco (la conexión entrega un par nuevo).
 */
export const mercadoLibreAccountMetaSchema = z.object({
  /** `user_id` de Mercado Libre, como texto. */
  userId: z.string().min(1),
  nickname: z.string(),
  siteId: z.literal(MERCADOLIBRE_SITE_ID),
  /** `user_type` de `/users/me` (por ejemplo, `normal` o `real_estate_agency`). */
  userType: z.string().nullable(),
  /** Los que entregó el canje: deben incluir `offline_access` y `write`. */
  scopes: z.array(z.string()),
  /** Si es un usuario de prueba de Mercado Libre (`tags` con `test_user`). */
  testUser: z.boolean(),
  connectedAt: z.iso.datetime(),
  tokenRefreshedAt: z.iso.datetime().nullable(),
  accessTokenExpiresAt: z.iso.datetime(),
  /** Siempre estimado: Mercado Libre no informa cuándo vence el `refresh_token`. */
  tokenExpiryEstimated: z.literal(true),
});
export type MercadoLibreAccountMeta = z.infer<typeof mercadoLibreAccountMetaSchema>;
