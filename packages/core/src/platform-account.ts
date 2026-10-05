import { z } from "zod";
import { PLATFORM_ACCOUNT_STATUSES, PLATFORMS } from "./enums.js";

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
 * Credenciales de una cuenta, ya descifradas: solo viven en memoria, nunca van a un log, un error,
 * una respuesta HTTP ni a los datos de un job. Se guardan cifradas (`credentials_encrypted`).
 */
export const platformCredentialsSchema = z.object({ accessToken: z.string().min(1) });
export type PlatformCredentials = z.infer<typeof platformCredentialsSchema>;
