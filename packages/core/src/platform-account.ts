import { z } from "zod";
import { PLATFORM_ACCOUNT_STATUSES, PLATFORMS, type Platform } from "./enums.js";
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

/*
 * Credenciales de una cuenta, ya descifradas: solo viven en memoria, nunca van a un log, un error,
 * una respuesta HTTP ni a los datos de un job. Se guardan cifradas (`credentials_encrypted`) como el
 * JSON de la variante de su plataforma, **sin** la plataforma adentro (spec F9 §4.7, ADR-0029 punto
 * 10): la plataforma es la de la fila, que ya va en la AAD (`platform:broker_id:external_account_id`).
 * Así las cuentas de antes de F9 (`{ accessToken }` y `{ accessToken, refreshToken }`) se leen igual.
 */

const secret = z.string().min(1);

/**
 * Marca de un token que **no vence** (spec F9 §4.7 y §4.17): `expires: "never"` dentro de las
 * credenciales cifradas. Es explícita porque `token_expires_at = null` ya significa «no se sabe
 * cuándo vence». Sin el campo, el token vence (o no se sabe) como siempre. Por ahora nada la usa:
 * será el token de un system user de Meta en el piloto (F10).
 */
export const TOKEN_NEVER_EXPIRES = "never";

/** Instagram y LinkedIn: solo el token de acceso (que puede marcarse como que no vence). */
export const accessTokenCredentialsSchema = z.object({
  accessToken: secret,
  expires: z.literal(TOKEN_NEVER_EXPIRES).optional(),
});
export type AccessTokenCredentials = z.infer<typeof accessTokenCredentialsSchema>;

/**
 * Mercado Libre (ADR-0015), como hasta F8: el `refreshToken` renueva el acceso, sirve una sola vez y
 * solo vale el último, así que se refresca con el candado de la cuenta. Sigue opcional para leer las
 * cuentas guardadas tal como están: sin él, `ensureAccessToken` pide reconectar.
 */
export const mercadoLibreCredentialsSchema = z.object({
  accessToken: secret,
  refreshToken: secret.optional(),
});
export type MercadoLibreCredentials = z.infer<typeof mercadoLibreCredentialsSchema>;

/** X y TikTok: el par de acceso y de renovar, los dos obligatorios (no hay cuentas de antes). */
export const refreshableCredentialsSchema = z.object({
  accessToken: secret,
  refreshToken: secret,
});
export type RefreshableCredentials = z.infer<typeof refreshableCredentialsSchema>;

/**
 * `https://discord.com/api/webhooks/<id>/<token>` (o `discordapp.com`): el id es numérico (un
 * snowflake) y el token es el secreto. Sin puerto, usuario, subdominio, consulta ni fragmento. Con
 * una expresión y no con `URL`: core no carga los tipos de Node ni del navegador.
 */
const DISCORD_WEBHOOK_URL =
  /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{1,30}\/[\w-]{1,200}$/;

/**
 * La URL de un webhook de Discord. Toda la URL es el secreto: quien la tiene publica en el canal.
 * El mensaje de error nunca lleva la URL.
 */
export const discordWebhookUrlSchema = z
  .string()
  .regex(DISCORD_WEBHOOK_URL, "No es la URL de un webhook de Discord");

/** Discord: la URL del webhook del canal, que hace de credencial. */
export const discordCredentialsSchema = z.object({ webhookUrl: discordWebhookUrlSchema });
export type DiscordCredentials = z.infer<typeof discordCredentialsSchema>;

/**
 * El esquema de las credenciales de cada plataforma. Marketplace no guarda (ADR-0017): su sesión
 * vive en el perfil del navegador.
 */
export const PLATFORM_CREDENTIALS_SCHEMAS = {
  instagram: accessTokenCredentialsSchema,
  linkedin: accessTokenCredentialsSchema,
  portal_inmobiliario: mercadoLibreCredentialsSchema,
  x: refreshableCredentialsSchema,
  tiktok: refreshableCredentialsSchema,
  discord: discordCredentialsSchema,
  fb_marketplace: z.null(),
} as const satisfies Record<Platform, z.ZodType>;

/** Las credenciales de una plataforma (`null` en Marketplace). */
export type PlatformCredentialsFor<P extends Platform> = z.infer<
  (typeof PLATFORM_CREDENTIALS_SCHEMAS)[P]
>;

type CredentialsVariant = NonNullable<PlatformCredentialsFor<Platform>>;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/** Cada variante declara ausentes (`?: undefined`) las claves de las demás. */
type Exclusive<T, All> = T extends unknown
  ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined }
  : never;

/**
 * Las credenciales de cualquier cuenta que las guarda: una variante por plataforma. Cada variante
 * declara ausentes las claves de las otras, así se lee `credentials.refreshToken` (o `webhookUrl`)
 * sin estrechar antes: es `undefined` donde no va.
 */
export type PlatformCredentials = Exclusive<CredentialsVariant, CredentialsVariant>;

/** Las credenciales que llevan un token de acceso (todas menos las de Discord). */
export type TokenCredentials = Exclude<PlatformCredentials, DiscordCredentials>;

const credentialsEntry = <P extends Platform>(platform: P) =>
  z.object({
    platform: z.literal(platform),
    credentials: PLATFORM_CREDENTIALS_SCHEMAS[platform],
  });

/**
 * La unión por plataforma (spec F9 §4.7): `{ platform, credentials }`, con `platform` como
 * discriminante. Lo guardado no lleva `platform` (sale de la fila), así que quien lee arma el par.
 */
export const platformCredentialsSchema = z.discriminatedUnion("platform", [
  credentialsEntry("instagram"),
  credentialsEntry("linkedin"),
  credentialsEntry("portal_inmobiliario"),
  credentialsEntry("x"),
  credentialsEntry("tiktok"),
  credentialsEntry("discord"),
  credentialsEntry("fb_marketplace"),
]);
export type PlatformCredentialsEntry = z.infer<typeof platformCredentialsSchema>;

// Cada plataforma tiene su variante: si `PLATFORMS` suma una, esto no compila hasta agregarla.
type MissingCredentialsPlatform = Exclude<Platform, PlatformCredentialsEntry["platform"]>;
const everyPlatformHasCredentials: [MissingCredentialsPlatform] extends [never] ? true : never =
  true;
void everyPlatformHasCredentials;

/**
 * Sin plataforma (compatibilidad con F3 a F8): cualquiera de las variantes, estricta (una clave de
 * otra variante o desconocida no se descarta en silencio: no calza). Lo que se guarda pasa siempre
 * por el esquema de la plataforma de la cuenta.
 */
const anyCredentialsSchema = z.union([
  z.strictObject(accessTokenCredentialsSchema.shape),
  z.strictObject(mercadoLibreCredentialsSchema.shape),
  z.strictObject(discordCredentialsSchema.shape),
]);

const credentialsInvalid = () =>
  new AppError("CREDENTIALS_INVALID", "Las credenciales de la cuenta no son válidas");

/**
 * Valida las credenciales antes de guardarlas: con la plataforma, contra su variante (Discord exige
 * `webhookUrl`; las de token, `accessToken`; X y TikTok también `refreshToken`). Sin ella, contra
 * cualquiera. `CREDENTIALS_INVALID` (no reintentable) si no calzan, también en Marketplace (que no
 * guarda credenciales). El error no lleva el valor recibido.
 */
export function checkCredentials(credentials: unknown): PlatformCredentials;
export function checkCredentials<P extends Platform>(
  credentials: unknown,
  platform: P,
): NonNullable<PlatformCredentialsFor<P>>;
export function checkCredentials(credentials: unknown, platform?: Platform): PlatformCredentials {
  const schema =
    platform === undefined ? anyCredentialsSchema : PLATFORM_CREDENTIALS_SCHEMAS[platform];
  const parsed = schema.safeParse(credentials);
  if (!parsed.success || parsed.data === null) throw credentialsInvalid();
  return parsed.data;
}

/** Si las credenciales llevan un token de acceso (todas menos el webhook de Discord). */
export const hasAccessToken = (credentials: PlatformCredentials): credentials is TokenCredentials =>
  typeof credentials.accessToken === "string";

/**
 * El token de acceso de unas credenciales. `ACCESS_TOKEN_UNAVAILABLE` (no reintentable) si la
 * plataforma no usa token (Discord): pedirlo es un error de programación.
 */
export function accessTokenOf(credentials: PlatformCredentials): string {
  if (hasAccessToken(credentials)) return credentials.accessToken;
  throw new AppError("ACCESS_TOKEN_UNAVAILABLE", "Esta cuenta no usa un token de acceso");
}

/** Si el token está marcado como que no vence (`expires: "never"`). */
export const tokenNeverExpires = (credentials: PlatformCredentials): boolean =>
  credentials.expires === TOKEN_NEVER_EXPIRES;

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

/**
 * Plataformas cuya cuenta conectada no guarda credenciales (ADR-0017): en Marketplace la sesión
 * vive en el perfil del navegador del corredor, fuera de la base.
 */
export const SESSION_PROFILE_PLATFORMS = ["fb_marketplace"] as const satisfies readonly Platform[];

/** Si la cuenta de una plataforma vive en un perfil del navegador, sin credenciales en la base. */
export const usesSessionProfile = (platform: Platform): boolean =>
  (SESSION_PROFILE_PLATFORMS as readonly Platform[]).includes(platform);

/**
 * Las credenciales de una cuenta que se conecta, según su plataforma (ADR-0017): Marketplace no
 * tiene (`null`) y las demás exigen la variante de su plataforma (Discord, `{ webhookUrl }`; spec
 * F9 §4.7). Errores (no reintentables, sin el valor recibido): `ACCOUNT_CREDENTIALS_REQUIRED` si
 * faltan, `ACCOUNT_CREDENTIALS_NOT_ALLOWED` si llegan a una cuenta de Marketplace (su sesión nunca
 * va a la base) y `CREDENTIALS_INVALID` si no calzan con su plataforma.
 */
export function checkConnectedCredentials<P extends Platform>(
  platform: P,
  credentials: unknown,
): NonNullable<PlatformCredentialsFor<P>> | null;
export function checkConnectedCredentials(
  platform: Platform,
  credentials: unknown,
): PlatformCredentials | null {
  if (usesSessionProfile(platform)) {
    if (credentials === null || credentials === undefined) return null;
    throw new AppError(
      "ACCOUNT_CREDENTIALS_NOT_ALLOWED",
      "Una cuenta de Marketplace no guarda credenciales: su sesión vive en el perfil del navegador",
      { details: { platform } },
    );
  }
  if (credentials === null || credentials === undefined) {
    throw new AppError(
      "ACCOUNT_CREDENTIALS_REQUIRED",
      "Falta el acceso de la cuenta al conectarla",
      {
        details: { platform },
      },
    );
  }
  return checkCredentials(credentials, platform);
}

/**
 * `meta` de una cuenta de Marketplace con el perfil del navegador (spec F5 §4.2, ADR-0017). No
 * lleva secretos: nada de cookies.
 * - `userId`: el id de la cookie `c_user` del perfil (lo único que se lee de las cookies; que sea
 *   el id de la cuenta es NO VERIFICADO hasta `fb:smoke`).
 * - `sessionCheckedAt`: la última vez que el sistema vio la sesión abierta (al conectar).
 * - `lastLoginError`: el código del último intento de inicio de sesión que falló, si la cuenta ya
 *   existía (para que la CLI y el panel lo muestren).
 */
export const marketplaceProfileMetaSchema = z.object({
  mode: z.literal("profile"),
  userId: z.string().regex(/^\d{1,30}$/),
  connectedAt: z.iso.datetime(),
  sessionCheckedAt: z.iso.datetime(),
  lastLoginError: z.object({ code: z.string().min(1), at: z.iso.datetime() }).optional(),
});
export type MarketplaceProfileMeta = z.infer<typeof marketplaceProfileMetaSchema>;

/**
 * `meta` de una cuenta de Marketplace **a mano** (spec F7 §4.8, ADR-0023): el corredor publica él
 * mismo; sin perfil del navegador, credenciales ni límite diario. `external_account_id` es
 * `MANUAL_MARKETPLACE_ACCOUNT_ID`.
 */
export const marketplaceManualMetaSchema = z.object({
  mode: z.literal("manual"),
  connectedAt: z.iso.datetime(),
});
export type MarketplaceManualMeta = z.infer<typeof marketplaceManualMetaSchema>;

/** El `external_account_id` de una cuenta de Marketplace a mano. */
export const MANUAL_MARKETPLACE_ACCOUNT_ID = "manual";

/** El nombre que queda en una cuenta cuyos datos se borraron a pedido de Meta (F8-T17, ADR-0027). */
export const ERASED_ACCOUNT_DISPLAY_NAME = "(datos borrados a pedido de Meta)";

/**
 * El `external_account_id` que reemplaza al de Instagram en una cuenta borrada a pedido de Meta
 * (ADR-0027): único (lleva el id de la cuenta, por la restricción de corredor, plataforma y cuenta
 * externa) y nunca un id de Instagram.
 */
export const erasedExternalAccountId = (accountId: string): string => `borrada:${accountId}`;

/**
 * `meta` de una cuenta de Marketplace: con el perfil del navegador (F5) o a mano (F7), por `mode`.
 * Las filas de F5 no tienen `mode`: se leen como `"profile"`.
 */
export const marketplaceAccountMetaSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !("mode" in value)
      ? { ...value, mode: "profile" }
      : value,
  z.discriminatedUnion("mode", [marketplaceProfileMetaSchema, marketplaceManualMetaSchema]),
);
export type MarketplaceAccountMeta = z.infer<typeof marketplaceAccountMetaSchema>;

/**
 * Si una cuenta es de Marketplace a mano (ADR-0023): por su `meta` (`mode: "manual"`) o por su
 * `external_account_id` (`"manual"`), así una a mano con el `meta` roto nunca abre el perfil. Una
 * de otra plataforma no lo es.
 */
export function isManualMarketplaceAccount(
  account: Pick<PlatformAccount, "platform" | "meta"> &
    Partial<Pick<PlatformAccount, "externalAccountId">>,
): boolean {
  if (account.platform !== "fb_marketplace") return false;
  if (account.externalAccountId === MANUAL_MARKETPLACE_ACCOUNT_ID) return true;
  const meta = marketplaceAccountMetaSchema.safeParse(account.meta);
  return meta.success && meta.data.mode === "manual";
}
