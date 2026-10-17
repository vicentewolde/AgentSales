import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { PasswordHasher } from "@agentsales/core";

// Contraseñas con `scrypt` de Node (ADR-0021): sal propia por hash y comparación en tiempo
// constante. El formato guarda los parámetros, así se pueden subir sin invalidar lo guardado:
// `scrypt$N$r$p$<sal>$<hash>` (base64url).

const KEY_BYTES = 64;
const SALT_BYTES = 16;
/** N = 2^15, r = 8, p = 1: unos 32 MB y del orden de 100 ms por hash en un Mac. */
const DEFAULT_COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

/** Límites de lo que se acepta al leer un hash (uno inventado no puede pedir memoria de más). */
const MIN_COST = 2 ** 10;
const MAX_COST = 2 ** 20;

type Params = { N: number; r: number; p: number };

function derive(password: string, salt: Buffer, { N, r, p }: Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `maxmem` con holgura sobre lo que pide (128 · N · r).
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

function parse(stored: string): { params: Params; salt: Buffer; hash: Buffer } | null {
  const [scheme, n, r, p, salt, hash, ...rest] = stored.split("$");
  if (scheme !== "scrypt" || rest.length > 0 || salt === undefined || hash === undefined) {
    return null;
  }
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (
    !isPowerOfTwo(params.N) ||
    params.N < MIN_COST ||
    params.N > MAX_COST ||
    !Number.isInteger(params.r) ||
    params.r < 1 ||
    params.r > 32 ||
    !Number.isInteger(params.p) ||
    params.p < 1 ||
    params.p > 4
  ) {
    return null;
  }
  const saltBytes = Buffer.from(salt, "base64url");
  const hashBytes = Buffer.from(hash, "base64url");
  if (saltBytes.length < SALT_BYTES || hashBytes.length !== KEY_BYTES) return null;
  return { params, salt: saltBytes, hash: hashBytes };
}

/**
 * `PasswordHasher` (puerto de core) con `scrypt`. `cost` (N) solo se baja en los tests: los
 * hashes guardan su N, así que verificar sirve con cualquiera dentro de los límites.
 */
export function createPasswordHasher(options: { cost?: number } = {}): PasswordHasher {
  const params: Params = { N: options.cost ?? DEFAULT_COST, r: BLOCK_SIZE, p: PARALLELISM };
  if (!isPowerOfTwo(params.N) || params.N < MIN_COST || params.N > MAX_COST) {
    throw new RangeError("cost debe ser una potencia de 2 entre 2^10 y 2^20");
  }
  // Para `verify(…, null)`: el mismo trabajo que una contraseña de verdad.
  const dummySalt = randomBytes(SALT_BYTES);
  return {
    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      const key = await derive(password, salt, params);
      return [
        "scrypt",
        params.N,
        params.r,
        params.p,
        salt.toString("base64url"),
        key.toString("base64url"),
      ].join("$");
    },
    async verify(password, stored) {
      const parsed = stored === null ? null : parse(stored);
      if (parsed === null) {
        await derive(password, dummySalt, params);
        return false;
      }
      const key = await derive(password, parsed.salt, parsed.params);
      return timingSafeEqual(key, parsed.hash);
    },
  };
}
