import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMetaUserIdHasher, createSignedRequestVerifier } from "./signed-request.js";

// F8-T17 (spec F8 §4.11, D18): la firma de las vueltas de Meta.

const IG_SECRET = "clave-de-la-app-de-instagram";
const FB_SECRET = "clave-de-la-app-de-meta";

/** Un `signed_request` como los de Meta: `<firma>.<carga>` en base64url, firmado con `secret`. */
function signedRequest(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${signature}.${body}`;
}

const PAYLOAD = {
  algorithm: "HMAC-SHA256",
  expires: 1_792_000_000,
  issued_at: 1_791_990_000,
  user_id: "17841400000000001",
};

describe("createSignedRequestVerifier", () => {
  const verify = createSignedRequestVerifier([IG_SECRET, FB_SECRET]);

  it("la firma buena con cualquiera de las dos claves da el usuario y cuándo se firmó", () => {
    expect(verify(signedRequest(PAYLOAD, IG_SECRET))).toEqual({
      userId: "17841400000000001",
      issuedAt: 1_791_990_000,
    });
    expect(verify(signedRequest(PAYLOAD, FB_SECRET))?.userId).toBe("17841400000000001");
  });

  it("la firma de otra app, una carga alterada o una firma cambiada se rechazan", () => {
    expect(verify(signedRequest(PAYLOAD, "clave-de-otra-app"))).toBeNull();
    const good = signedRequest(PAYLOAD, IG_SECRET);
    const [signature, body] = good.split(".") as [string, string];
    const altered = Buffer.from(
      JSON.stringify({ ...PAYLOAD, user_id: "17841400000000002" }),
    ).toString("base64url");
    expect(verify(`${signature}.${altered}`)).toBeNull();
    expect(verify(`${signature.slice(0, -2)}AA.${body}`)).toBeNull();
  });

  it("lo mal formado se rechaza sin lanzar", () => {
    for (const value of ["", "solo-una-parte", "a.b.c", "!!!.???", `${"x".repeat(9000)}.y`]) {
      expect(verify(value)).toBeNull();
    }
    // Otro algoritmo, sin usuario o con una carga que no es JSON, aunque la firma calce.
    expect(verify(signedRequest({ ...PAYLOAD, algorithm: "HMAC-SHA1" }, IG_SECRET))).toBeNull();
    expect(verify(signedRequest({ algorithm: "HMAC-SHA256" }, IG_SECRET))).toBeNull();
    const notJson = Buffer.from("no es json").toString("base64url");
    const signature = createHmac("sha256", IG_SECRET).update(notJson).digest("base64url");
    expect(verify(`${signature}.${notJson}`)).toBeNull();
  });

  it("un user_id numérico seguro se acepta como texto; uno que pierde dígitos, no", () => {
    expect(verify(signedRequest({ ...PAYLOAD, user_id: 12345 }, IG_SECRET))?.userId).toBe("12345");
    expect(
      verify(signedRequest({ ...PAYLOAD, user_id: Number.MAX_SAFE_INTEGER + 2 }, IG_SECRET)),
    ).toBeNull();
  });

  it("sin claves configuradas, todo se rechaza", () => {
    const none = createSignedRequestVerifier([undefined, ""]);
    expect(none(signedRequest(PAYLOAD, ""))).toBeNull();
  });
});

describe("createMetaUserIdHasher", () => {
  it("es un HMAC con clave: estable con la misma clave, distinto con otra, nunca el id ni su SHA-256", () => {
    const hash = createMetaUserIdHasher("k".repeat(32));
    const value = hash(PAYLOAD.user_id);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(PAYLOAD.user_id)).toBe(value);
    expect(createMetaUserIdHasher("otra-clave-de-32-caracteres-o-mas!!")(PAYLOAD.user_id)).not.toBe(
      value,
    );
    const plainSha = createHash("sha256").update(PAYLOAD.user_id).digest("hex");
    expect(value).not.toBe(plainSha);
    expect(value).not.toContain(PAYLOAD.user_id);
  });
});
