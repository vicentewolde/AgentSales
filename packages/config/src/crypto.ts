import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError, type SecretBox } from "@agentsales/core";

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

/**
 * base64url estricto: solo su alfabeto y en forma canónica (`Buffer.from` ignoraría caracteres
 * inválidos y aceptaría variantes del último carácter). `null` si no lo es.
 */
function decodeBase64url(text: string): Buffer | null {
  if (!/^[\w-]*$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

const unreadable = (reason: string) =>
  new AppError(
    "CREDENTIALS_UNREADABLE",
    "No se pudieron leer las credenciales guardadas: reconecta la cuenta",
    { details: { reason } },
  );

/**
 * `SecretBox` (puerto de core) con AES-256-GCM: `encrypt` devuelve `v1.<iv>.<cifrado>.<tag>` en
 * base64url, con IV aleatorio. El repositorio de cuentas usa la AAD `platform:external_account_id`.
 */
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
      const [iv, ciphertext, tag] = parts.slice(1).map(decodeBase64url);
      if (iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES || !ciphertext) {
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

/**
 * Datos que viajan firmados en el `state` del OAuth (sin secretos: van en la URL de Instagram).
 * `nonce` y `exp` los pone el firmador.
 */
export type SignedState = Readonly<Record<string, string | number | boolean>> & {
  readonly nonce?: never;
  readonly exp?: never;
};

/**
 * Firma y verifica el `state` del OAuth con HMAC-SHA256 (spec F3 §4.6). El token lleva los datos,
 * un nonce aleatorio y el vencimiento, en base64url: `<datos>.<firma>`. No cifra: los datos son
 * visibles, solo no se pueden alterar.
 */
export interface StateSigner {
  sign(data: SignedState, options: { ttlSeconds: number; now?: Date }): string;
  /** Lanza `OAUTH_STATE_INVALID` si la firma no calza, el formato es otro o ya venció. */
  verify(
    token: string,
    options?: { now?: Date },
  ): Readonly<Record<string, string | number | boolean>> & { nonce: string; exp: number };
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
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError("ttlSeconds debe ser un entero mayor que 0");
      }
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
      const given = decodeBase64url(signature);
      if (given === null || given.length !== expected.length || !timingSafeEqual(given, expected)) {
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
      const state = data as Readonly<Record<string, string | number | boolean>> & {
        nonce: string;
        exp: number;
      };
      if (state.exp <= Math.floor(now.getTime() / 1000)) throw invalidState("expired");
      return state;
    },
  };
}
