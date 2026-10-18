import { createHmac, timingSafeEqual } from "node:crypto";

// Las vueltas de Meta (spec F8 §4.11, D18): quitar la app y borrar los datos llegan como un `POST`
// con `signed_request` = `<firma>.<carga>`, las dos partes en base64url. La firma es el HMAC-SHA256
// de la carga (tal como llega, en base64url) con la clave de la app (nota de Instagram §13.4).
// Vive aquí (con `node:crypto`) y la API la recibe inyectada: las rutas no importan `node:*`.

/** Lo que importa de la carga: el usuario de Instagram (con alcance de la app) y cuándo se firmó. */
export type SignedRequestPayload = {
  userId: string;
  /** `issued_at` en segundos, si viene. */
  issuedAt: number | null;
};

/** Verifica un `signed_request`: la carga si la firma calza, `null` si no (sin decir por qué). */
export type SignedRequestVerifier = (signedRequest: string) => SignedRequestPayload | null;

/** El tope de un `signed_request` (los de Meta traen unos pocos cientos de caracteres). */
const MAX_SIGNED_REQUEST_LENGTH = 8 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const decode = (part: string): Buffer | null =>
  BASE64URL.test(part) ? Buffer.from(part.replace(/=+$/, ""), "base64url") : null;

function readPayload(json: Buffer): SignedRequestPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(json.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.algorithm !== "string" || record.algorithm.toUpperCase() !== "HMAC-SHA256") {
    return null;
  }
  // Meta lo manda como texto; un número entero también se acepta (sin perder dígitos: debe ser seguro).
  const raw = record.user_id;
  const userId =
    typeof raw === "string" ? raw : Number.isSafeInteger(raw) ? String(raw) : undefined;
  if (userId === undefined || !/^[0-9A-Za-z_-]{1,64}$/.test(userId)) return null;
  const issuedAt = typeof record.issued_at === "number" ? record.issued_at : null;
  return { userId, issuedAt };
}

/**
 * Arma el verificador con las claves que pueden firmar: la de la app de Instagram y la de la app de
 * Meta (cuál firma con Instagram Login es NO VERIFICADO, nota §13.4: se acepta cualquiera). Las
 * vacías o ausentes se ignoran; sin ninguna, todo `signed_request` se rechaza.
 */
export function createSignedRequestVerifier(
  secrets: readonly (string | undefined)[],
): SignedRequestVerifier {
  const keys = secrets.filter((secret): secret is string => (secret ?? "") !== "");
  return (signedRequest) => {
    if (keys.length === 0 || signedRequest.length > MAX_SIGNED_REQUEST_LENGTH) return null;
    const parts = signedRequest.split(".");
    if (parts.length !== 2) return null;
    const [signaturePart = "", payloadPart = ""] = parts;
    const signature = decode(signaturePart);
    const payload = decode(payloadPart);
    if (signature === null || payload === null || signature.length !== 32) return null;
    // La firma se compara contra cada clave en tiempo constante, sin cortar en la primera que falla.
    let valid = false;
    for (const key of keys) {
      const expected = createHmac("sha256", key).update(payloadPart, "utf8").digest();
      if (timingSafeEqual(expected, signature)) valid = true;
    }
    return valid ? readPayload(payload) : null;
  };
}
