import { describe, expect, it } from "vitest";
import { createPasswordHasher } from "./password.js";
import { createSecretTokens } from "./secret-tokens.js";

// F7-T03 (ADR-0021): `scrypt` con sal propia y los tokens de sesión. El costo se baja en los tests
// (el hash guarda su N): el de producción tarda del orden de 100 ms.

const hasher = createPasswordHasher({ cost: 2 ** 10 });

describe("contraseñas con scrypt", () => {
  it("verifica la correcta y rechaza otra; dos hashes de la misma no se parecen", async () => {
    const first = await hasher.hash("una-clave-larga-1");
    const second = await hasher.hash("una-clave-larga-1");
    expect(first).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("una-clave-larga-1");
    expect(await hasher.verify("una-clave-larga-1", first)).toBe(true);
    expect(await hasher.verify("una-clave-larga-2", first)).toBe(false);
  });

  it("verifica con los parámetros del hash, no con los del hasher", async () => {
    const stored = await hasher.hash("otra-clave-larga");
    const other = createPasswordHasher({ cost: 2 ** 11 });
    expect(await other.verify("otra-clave-larga", stored)).toBe(true);
  });

  it("sin hash (usuario inexistente) o con uno inventado devuelve false", async () => {
    expect(await hasher.verify("lo-que-sea-largo", null)).toBe(false);
    for (const stored of [
      "",
      "bcrypt$x",
      "scrypt$1024$8$1$c2Fs",
      // N enorme, o N y r que juntos piden más de 128 MB: no se intenta.
      `scrypt$${2 ** 24}$8$1$${"a".repeat(22)}$${"b".repeat(86)}`,
      `scrypt$${2 ** 20}$32$1$${"a".repeat(22)}$${"b".repeat(86)}`,
      "scrypt$1000$8$1$aaaaaaaaaaaaaaaaaaaaaa$bbbb",
    ]) {
      expect(await hasher.verify("lo-que-sea-largo", stored)).toBe(false);
    }
  });

  it("normaliza la contraseña (NFC): la misma con tildes en otra forma calza", async () => {
    const composed = "contraseña-larga".normalize("NFC");
    const decomposed = "contraseña-larga".normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(await hasher.verify(decomposed, await hasher.hash(composed))).toBe(true);
  });

  it("solo acepta un costo potencia de 2 dentro de los límites", () => {
    expect(() => createPasswordHasher({ cost: 1000 })).toThrow(RangeError);
    expect(() => createPasswordHasher({ cost: 2 ** 21 })).toThrow(RangeError);
  });
});

describe("tokens de sesión e invitación", () => {
  it("32 bytes aleatorios en base64url; el hash es SHA-256 y no contiene el token", () => {
    const tokens = createSecretTokens();
    const token = tokens.generate();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(tokens.generate()).not.toBe(token);
    const hash = tokens.hash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.hash(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });
});
