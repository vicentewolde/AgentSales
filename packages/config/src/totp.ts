import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TotpProvider } from "@agentsales/core";

// El doble factor con una app de códigos (spec F8 §4.8, ADR-0026, D15): TOTP del RFC 6238 con
// `node:crypto`, sin dependencias. SHA-1, 6 dígitos y 30 s, lo que entienden todas las apps
// (Google Authenticator, 1Password, Authy…). La clave nunca se loguea ni va en un error.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 160 bits, el largo que recomienda el RFC 4226 para SHA-1. */
const SECRET_BYTES = 20;
/** Un código de recuperación: 16 caracteres de base32 (80 bits), en grupos de 4. */
const RECOVERY_CODE_CHARS = 16;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 del RFC 4648 sin relleno (`=`), como la lleva el enlace `otpauth://`. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Lee base32 sin importar mayúsculas, espacios ni relleno; `null` si trae otro carácter. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export type HotpAlgorithm = "sha1" | "sha256" | "sha512";

/** HOTP (RFC 4226): el código de un contador, con el truncado dinámico. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  { digits = TOTP_DIGITS, algorithm = "sha1" }: { digits?: number; algorithm?: HotpAlgorithm } = {},
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** El paso de 30 s de un instante (el contador de TOTP). */
export const totpStepOf = (at: Date): number =>
  Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/**
 * `TotpProvider` (puerto de core). `matchStep` acepta el paso actual y uno antes o después (±30 s,
 * por la hora del teléfono) y compara en tiempo constante; quien llama rechaza un paso ya usado.
 */
export function createTotpProvider(): TotpProvider {
  return {
    generateSecret: () => base32Encode(randomBytes(SECRET_BYTES)),
    matchStep(secret, code, now) {
      if (!/^\d{6}$/.test(code)) return null;
      const key = base32Decode(secret);
      if (key === null || key.length === 0) return null;
      const current = totpStepOf(now);
      const given = Buffer.from(code);
      let matched: number | null = null;
      // Se revisan los tres siempre: el tiempo no dice cuál calzó.
      for (const step of [current - 1, current, current + 1]) {
        if (timingSafeEqual(Buffer.from(hotp(key, step)), given)) matched = step;
      }
      return matched;
    },
    generateRecoveryCode() {
      const chars = base32Encode(randomBytes(10)).slice(0, RECOVERY_CODE_CHARS);
      return chars.match(/.{4}/g)?.join("-") ?? chars;
    },
  };
}
