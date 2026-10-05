/**
 * Cifra y descifra textos cortos (los tokens de una cuenta conectada), spec F3 §4.6. Lo implementa
 * `createSecretBox` de `@agentsales/config` (AES-256-GCM con la clave derivada de
 * `APP_ENCRYPTION_KEY`) y lo inyectan las apps en el repositorio de cuentas: los paquetes no cargan
 * el entorno. `aad` (datos asociados, sin cifrar) ata el cifrado a su dueño, así un cifrado copiado
 * a otra fila no se descifra.
 */
export interface SecretBox {
  /** Devuelve el texto cifrado (sin secretos legibles); dos llamadas con el mismo texto difieren. */
  encrypt(plaintext: string, aad: string): string;
  /** Lanza `CREDENTIALS_UNREADABLE` (no reintentable) si el texto, la clave o la `aad` no calzan. */
  decrypt(sealed: string, aad: string): string;
}
