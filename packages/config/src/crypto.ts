import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "@agentsales/core";

// Cifrado de credenciales y firma del `state` del OAuth (spec F3 §4.6). Las dos claves de 32 bytes
// se derivan de `APP_ENCRYPTION_KEY` con HKDF-SHA256, una por propósito (`info`): una clave filtrada
// de un uso no sirve para el otro. Nunca se loguean claves, textos ni cifrados.

/** Sal fija de la derivación: separa estas claves de cualquier otro uso del mismo secreto. */
const HKDF_SALT = "agentsales/hkdf/v1";
const KEY_BYTES = 32;

/** Propósitos de cada clave derivada (`info` de HKDF). Cambiar uno invalida lo ya cifrado o firmado. */
export const KEY_PURPOSES = {
  credentials: "agentsales/credentials/v1",
  oauthState: "agentsales/oauth-state/v1",
} as const;

/** Clave de 32 bytes derivada de `APP_ENCRYPTION_KEY` para un propósito (HKDF-SHA256). */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, info, KEY_BYTES));
}

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Cifra y descifra textos cortos (los tokens de una cuenta conectada) con AES-256-GCM.
 * `aad` (datos asociados, sin cifrar) ata el cifrado a su dueño: el repositorio usa
 * `platform:external_account_id`, así un cifrado copiado a otra fila no se descifra.
 */
export interface SecretBox {
  /** Devuelve `v1.<iv>.<cifrado>.<tag>` en base64url; dos llamadas con el mismo texto difieren. */
  encrypt(plaintext: string, aad: string): string;
  /** Lanza `CREDENTIALS_UNREADABLE` (no reintentable) si el texto, la clave o la `aad` no calzan. */
  decrypt(sealed: string, aad: string): string;
}

const unreadable = (reason: string) =>
  new AppError(
    "CREDENTIALS_UNREADABLE",
    "No se pudieron leer las credenciales guardadas: reconecta la cuenta",
    { details: { reason } },
  );

export function createSecretBox(appEncryptionKey: string): SecretBox {
  const key = deriveKey(appEncryptionKey, KEY_PURPOSES.credentials);
  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [FORMAT_VERSION, iv, ciphertext, tag]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },
    decrypt(sealed, aad) {
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) throw unreadable("format");
      const [iv, ciphertext, tag] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
      if (iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES || ciphertext === undefined) {
        throw unreadable("format");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Otra clave, otra `aad` o un byte cambiado: GCM no distingue, y no hace falta.
        throw unreadable("authentication");
      }
    },
  };
}

/** Datos que viajan firmados en el `state` del OAuth (sin secretos: van en la URL de Instagram). */
export type SignedState = Readonly<Record<string, string | number | boolean>>;

/**
 * Firma y verifica el `state` del OAuth con HMAC-SHA256 (spec F3 §4.6). El token lleva los datos,
 * un nonce aleatorio y el vencimiento, en base64url: `<datos>.<firma>`. No cifra: los datos son
 * visibles, solo no se pueden alterar.
 */
export interface StateSigner {
  sign(data: SignedState, options: { ttlSeconds: number; now?: Date }): string;
  /** Lanza `OAUTH_STATE_INVALID` si la firma no calza, el formato es otro o ya venció. */
  verify(token: string, options?: { now?: Date }): SignedState & { nonce: string; exp: number };
}

const invalidState = (reason: string) =>
  new AppError("OAUTH_STATE_INVALID", "La conexión venció o no es válida: vuelve a empezar", {
    details: { reason },
  });

export function createStateSigner(appEncryptionKey: string): StateSigner {
  const key = deriveKey(appEncryptionKey, KEY_PURPOSES.oauthState);
  const mac = (payload: string) => createHmac("sha256", key).update(payload).digest();
  return {
    sign(data, { ttlSeconds, now = new Date() }) {
      const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
      const nonce = randomBytes(16).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ ...data, nonce, exp }), "utf8").toString(
        "base64url",
      );
      return `${payload}.${mac(payload).toString("base64url")}`;
    },
    verify(token, { now = new Date() } = {}) {
      const [payload, signature, ...rest] = token.split(".");
      if (payload === undefined || signature === undefined || rest.length > 0) {
        throw invalidState("format");
      }
      const expected = mac(payload);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw invalidState("signature");
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        throw invalidState("format");
      }
      if (
        typeof data !== "object" ||
        data === null ||
        typeof (data as { exp?: unknown }).exp !== "number" ||
        typeof (data as { nonce?: unknown }).nonce !== "string"
      ) {
        throw invalidState("format");
      }
      const state = data as SignedState & { nonce: string; exp: number };
      if (state.exp <= Math.floor(now.getTime() / 1000)) throw invalidState("expired");
      return state;
    },
  };
}
