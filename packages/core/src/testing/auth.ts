import { AppError } from "../errors.js";
import type { PasswordHasher, SecretTokens, TotpProvider } from "../ports/auth.js";
import type { SecretBox } from "../ports/secret-box.js";

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

/**
 * El doble factor falso (F8-T15): el código de un paso es el paso en 6 dígitos
 * (`fakeTotpCode(step)`), la clave es `CLAVE-<n>` y los códigos de recuperación son base32
 * deterministas. Acepta ±1 paso, como el de verdad.
 */
export function createFakeTotpProvider(): TotpProvider {
  let secrets = 0;
  let recoveries = 0;
  return {
    generateSecret: () => `CLAVE${String.fromCharCode(65 + (secrets++ % 26))}`,
    matchStep(secret, code, now) {
      if (!/^\d{6}$/.test(code) || !secret.startsWith("CLAVE")) return null;
      const current = fakeTotpStep(now);
      for (const step of [current - 1, current, current + 1]) {
        if (fakeTotpCode(step) === code) return step;
      }
      return null;
    },
    generateRecoveryCode() {
      // 16 caracteres de base32, distintos cada vez: `AAAA-AAAA-AAAA-AAAB`, `…-AAAC`…
      let n = ++recoveries;
      let tail = "";
      for (let i = 0; i < 4; i += 1) {
        tail = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[n % 32] + tail;
        n = Math.floor(n / 32);
      }
      return `AAAA-AAAA-AAAA-${tail}`;
    },
  };
}

/** El paso de 30 s de un instante (como el de verdad). */
export const fakeTotpStep = (at: Date): number => Math.floor(at.getTime() / 30_000);
/** El código del doble factor falso para un paso. */
export const fakeTotpCode = (step: number): string => String(step % 1_000_000).padStart(6, "0");

/** `SecretBox` falso y legible (`sellado:<aad>:<texto>`): exige la misma AAD al abrir. */
export function createFakeSecretBox(): SecretBox {
  return {
    encrypt: (plaintext, aad) => `sellado:${aad}:${plaintext}`,
    decrypt(sealed, aad) {
      const prefix = `sellado:${aad}:`;
      if (!sealed.startsWith(prefix)) {
        throw new AppError("CREDENTIALS_UNREADABLE", "No se pudieron leer las credenciales");
      }
      return sealed.slice(prefix.length);
    },
  };
}
