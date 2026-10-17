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
