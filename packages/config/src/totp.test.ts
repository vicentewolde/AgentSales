import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, createTotpProvider, hotp, totpStepOf } from "./totp.js";

// F8-T15 (spec F8 §4.8): TOTP del RFC 6238 con `node:crypto`.

const SHA1_SECRET = Buffer.from("12345678901234567890");
const SHA256_SECRET = Buffer.from("12345678901234567890123456789012");
const SHA512_SECRET = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
);
const stepAt = (seconds: number) => totpStepOf(new Date(seconds * 1000));

describe("TOTP", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("los vectores del RFC 6238 (SHA-1, 8 dígitos): T=%i da %s", (seconds, code) => {
    expect(hotp(SHA1_SECRET, stepAt(seconds), { digits: 8 })).toBe(code);
  });

  it("los vectores del RFC 6238 con SHA-256 y SHA-512 (T=59)", () => {
    expect(hotp(SHA256_SECRET, stepAt(59), { digits: 8, algorithm: "sha256" })).toBe("46119246");
    expect(hotp(SHA512_SECRET, stepAt(59), { digits: 8, algorithm: "sha512" })).toBe("90693936");
  });

  it("base32 del RFC 4648: ida y vuelta, sin importar mayúsculas ni espacios", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw 6ytb oi======")?.toString()).toBe("foobar");
    expect(base32Decode("MZXW1")).toBeNull();
  });

  it("una clave nueva es base32 de 160 bits, distinta cada vez", () => {
    const totp = createTotpProvider();
    const secret = totp.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.generateSecret()).not.toBe(secret);
  });

  it("acepta el paso actual y ±30 s; uno más lejos, otro largo o letras, no", () => {
    const totp = createTotpProvider();
    const secret = base32Encode(SHA1_SECRET);
    const now = new Date(1111111111 * 1000);
    const step = totpStepOf(now);
    const codeAt = (offset: number) => hotp(SHA1_SECRET, step + offset);

    expect(totp.matchStep(secret, codeAt(0), now)).toBe(step);
    expect(totp.matchStep(secret, codeAt(-1), now)).toBe(step - 1);
    expect(totp.matchStep(secret, codeAt(1), now)).toBe(step + 1);
    expect(totp.matchStep(secret, codeAt(2), now)).toBeNull();
    expect(totp.matchStep(secret, codeAt(-2), now)).toBeNull();
    expect(totp.matchStep(secret, `${codeAt(0)}0`, now)).toBeNull();
    expect(totp.matchStep(secret, "12a456", now)).toBeNull();
    expect(totp.matchStep("no-es-base32!", codeAt(0), now)).toBeNull();
  });

  it("los códigos de recuperación son de 16 caracteres en grupos de 4", () => {
    const totp = createTotpProvider();
    const codes = new Set(Array.from({ length: 10 }, () => totp.generateRecoveryCode()));
    expect(codes.size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  });
});
