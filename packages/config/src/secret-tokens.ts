import { createHash, randomBytes } from "node:crypto";
import type { SecretTokens } from "@agentsales/core";

// Tokens de sesión e invitación (ADR-0021): 32 bytes aleatorios en base64url; la base guarda solo
// su SHA-256 (con 256 bits de azar no hace falta un hash lento).

const TOKEN_BYTES = 32;

export function createSecretTokens(): SecretTokens {
  return {
    generate: () => randomBytes(TOKEN_BYTES).toString("base64url"),
    hash: (token) => createHash("sha256").update(token, "utf8").digest("hex"),
  };
}
