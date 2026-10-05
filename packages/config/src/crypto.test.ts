import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox, createStateSigner, deriveKey, KEY_PURPOSES } from "./crypto.js";

const APP_KEY = "k".repeat(32);
const AAD = "instagram:17841400000000000";

/** HKDF-SHA256 escrito a mano (RFC 5869: extract y un bloque de expand), para no probar node contra sí mismo. */
function manualHkdf(secret: string, salt: string, info: string): string {
  const prk = createHmac("sha256", salt).update(secret).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest("hex");
}

describe("deriveKey (HKDF-SHA256)", () => {
  it("da la clave esperada para APP_ENCRYPTION_KEY y el propósito (vector fijo)", () => {
    const key = deriveKey(APP_KEY, KEY_PURPOSES.credentials);

    expect(key).toHaveLength(32);
    expect(key.toString("hex")).toBe(
      "12f82fcfc25a127be24c4facaf7ef4b2ccfbb5bede772767f63e7d678c72083c",
    );
    expect(key.toString("hex")).toBe(
      manualHkdf(APP_KEY, "agentsales/hkdf/v1", KEY_PURPOSES.credentials),
    );
  });

  it("cada propósito tiene su clave", () => {
    expect(deriveKey(APP_KEY, KEY_PURPOSES.credentials)).not.toEqual(
      deriveKey(APP_KEY, KEY_PURPOSES.oauthState),
    );
  });
});

/** Cambia el primer byte de una parte (`1` IV, `2` cifrado, `3` tag) de `v1.<iv>.<cifrado>.<tag>`. */
function flipByte(sealed: string, index: number): string {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[index] ?? "", "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  parts[index] = bytes.toString("base64url");
  return parts.join(".");
}

describe("createSecretBox (AES-256-GCM)", () => {
  const box = createSecretBox(APP_KEY);
  const token = JSON.stringify({ accessToken: "IGAA-token-de-prueba" });

  it("ida y vuelta con la misma AAD, también con un texto vacío o con tildes y emojis", () => {
    expect(box.decrypt(box.encrypt(token, AAD), AAD)).toBe(token);
    expect(box.decrypt(box.encrypt("", AAD), AAD)).toBe("");
    expect(box.decrypt(box.encrypt("Ñuñoa 🏢", AAD), AAD)).toBe("Ñuñoa 🏢");
  });

  it("el cifrado no contiene el texto, y dos cifrados del mismo texto difieren (IV aleatorio)", () => {
    const first = box.encrypt(token, AAD);
    const second = box.encrypt(token, AAD);

    expect(first).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toContain("IGAA");
    expect(first).not.toBe(second);
  });

  it.each([
    ["otra AAD", (sealed: string) => [sealed, "instagram:otra-cuenta"] as const],
    ["otra clave", (sealed: string) => [sealed, AAD, "z".repeat(32)] as const],
    ["un byte cambiado del IV", (sealed: string) => [flipByte(sealed, 1), AAD] as const],
    ["un byte cambiado del cifrado", (sealed: string) => [flipByte(sealed, 2), AAD] as const],
    ["un byte cambiado del tag", (sealed: string) => [flipByte(sealed, 3), AAD] as const],
    [
      "el tag truncado",
      (sealed: string) => {
        const parts = sealed.split(".");
        parts[3] = (parts[3] ?? "").slice(0, 16);
        return [parts.join("."), AAD] as const;
      },
    ],
    [
      "un carácter fuera de base64url",
      (sealed: string) => {
        const parts = sealed.split(".");
        parts[2] = `${parts[2] ?? ""}!`;
        return [parts.join("."), AAD] as const;
      },
    ],
    ["otro formato", () => ["v2.a.b.c", AAD] as const],
    ["un texto cualquiera", () => ["no-es-un-cifrado", AAD] as const],
  ])("%s da CREDENTIALS_UNREADABLE, no reintentable", (_, tamper) => {
    const [sealed, aad, otherKey] = tamper(box.encrypt(token, AAD));
    const reader = otherKey === undefined ? box : createSecretBox(otherKey);

    expect(() => reader.decrypt(sealed, aad)).toThrow(
      expect.objectContaining({ code: "CREDENTIALS_UNREADABLE", retriable: false }),
    );
  });

  it("el error no lleva el texto, el cifrado ni la clave", () => {
    const sealed = box.encrypt(token, AAD);
    let error: unknown;
    try {
      box.decrypt(sealed, "otra");
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error as object));

    expect(serialized).not.toContain("IGAA");
    expect(serialized).not.toContain(sealed);
    expect(serialized).not.toContain(APP_KEY);
  });
});

describe("createStateSigner (HMAC-SHA256)", () => {
  const signer = createStateSigner(APP_KEY);
  const now = new Date("2026-10-05T12:00:00Z");

  it("verifica lo que firmó, con nonce y vencimiento", () => {
    const token = signer.sign({ brokerId: "b1" }, { ttlSeconds: 600, now });
    const state = signer.verify(token, { now: new Date("2026-10-05T12:09:59Z") });

    expect(state).toMatchObject({ brokerId: "b1", exp: now.getTime() / 1000 + 600 });
    expect(state.nonce).toMatch(/^[\w-]{20,}$/);
  });

  it("rechaza un vencimiento que no es un entero positivo", () => {
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() => signer.sign({ brokerId: "b1" }, { ttlSeconds, now })).toThrow(RangeError);
    }
  });

  it("dos firmas de los mismos datos difieren (nonce)", () => {
    expect(signer.sign({ brokerId: "b1" }, { ttlSeconds: 600, now })).not.toBe(
      signer.sign({ brokerId: "b1" }, { ttlSeconds: 600, now }),
    );
  });

  it.each([
    ["vencido", (token: string) => token, new Date("2026-10-05T12:10:00Z")],
    [
      "con los datos alterados",
      (token: string) => {
        const [, signature] = token.split(".");
        const forged = Buffer.from(
          JSON.stringify({ brokerId: "otro", nonce: "n", exp: 9_999_999_999 }),
        ).toString("base64url");
        return `${forged}.${signature}`;
      },
      now,
    ],
    [
      "con la firma alterada",
      (token: string) => {
        const [payload, signature = ""] = token.split(".");
        const flipped = signature.startsWith("A") ? "B" : "A";
        return `${payload}.${flipped}${signature.slice(1)}`;
      },
      now,
    ],
    [
      "de otra clave",
      () => createStateSigner("z".repeat(32)).sign({}, { ttlSeconds: 600, now }),
      now,
    ],
    ["sin firma", (token: string) => token.split(".")[0] ?? "", now],
    ["con partes de más", (token: string) => `${token}.x`, now],
  ])("rechaza un state %s con OAUTH_STATE_INVALID", (_, tamper, at) => {
    const token = tamper(signer.sign({ brokerId: "b1" }, { ttlSeconds: 600, now }));

    expect(() => signer.verify(token, { now: at })).toThrow(
      expect.objectContaining({ code: "OAUTH_STATE_INVALID", retriable: false }),
    );
  });
});
