import type { PasswordHasher, SecretTokens } from "../ports/auth.js";

/**
 * Hash de contraseñas falso y rápido para los tests (`fake:<contraseña>`). Cuenta las llamadas a
 * `verify` con `null`, para probar que un correo inexistente también hace el trabajo.
 */
export function createFakePasswordHasher(): PasswordHasher & { dummyVerifications(): number } {
  let dummies = 0;
  return {
    async hash(password) {
      return `fake:${password}`;
    },
    async verify(password, hash) {
      if (hash === null) {
        dummies++;
        return false;
      }
      return hash === `fake:${password}`;
    },
    dummyVerifications: () => dummies,
  };
}

/** Tokens deterministas (`token-1`, `token-2`…) con un hash legible (`sha:<token>`). */
export function createFakeSecretTokens(): SecretTokens {
  let next = 0;
  return {
    generate: () => `token-${++next}`,
    hash: (token) => `sha:${token}`,
  };
}
