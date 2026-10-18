// Puertos de la autenticación (ADR-0021): las implementaciones con `node:crypto` viven en
// `@agentsales/config`, como `SecretBox`; core no importa criptografía.

/** Hash de contraseñas (`scrypt` en config). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /**
   * Si la contraseña calza con el hash. Con `null` (el usuario no existe o no tiene contraseña)
   * hace el mismo trabajo contra un hash de relleno y devuelve `false`: el tiempo no delata nada.
   */
  verify(password: string, hash: string | null): Promise<boolean>;
}

/** Tokens aleatorios de sesión e invitación, y su hash (lo único que se guarda). */
export interface SecretTokens {
  generate(): string;
  hash(token: string): string;
}

/**
 * El doble factor con una app de códigos (spec F8 §4.8, ADR-0026): TOTP del RFC 6238 en config.
 * La clave va en base32; core nunca la loguea ni la pone en un error.
 */
export interface TotpProvider {
  /** Una clave nueva, en base32 (la que se copia en la app del teléfono). */
  generateSecret(): string;
  /**
   * El paso de 30 s que calza con el código, buscando ±1 paso alrededor de `now`; `null` si
   * ninguno calza (o el código no son 6 dígitos). Quien llama rechaza un paso ya usado.
   */
  matchStep(secret: string, code: string, now: Date): number | null;
  /** Un código de recuperación nuevo (`XXXX-XXXX-XXXX-XXXX`, base32). */
  generateRecoveryCode(): string;
}
