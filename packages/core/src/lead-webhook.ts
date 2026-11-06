import type { LeadWebhookKeyRepository } from "./ports/lead-webhook-key-repository.js";

// El secreto por corredor del webhook de leads (F10-T04, ADR-0033 punto 4). core no toca
// `node:crypto`: el azar, el hash y la comparación en tiempo constante los pone quien compone.

export type LeadWebhookSecretDeps = {
  keys: LeadWebhookKeyRepository;
  /** Un secreto nuevo e impredecible (por ejemplo, 32 bytes aleatorios en base64url). */
  randomSecret: () => string;
  /** sha256 hexadecimal del secreto. */
  hash: (secret: string) => string;
  /** Comparación en tiempo constante de dos textos. */
  safeEqual: (a: string, b: string) => boolean;
};

/** Genera o rota el secreto del corredor y lo devuelve **una sola vez**; solo queda su hash. */
export async function issueLeadWebhookSecret(
  deps: Pick<LeadWebhookSecretDeps, "keys" | "randomSecret" | "hash">,
  brokerId: string,
): Promise<{ secret: string }> {
  const secret = deps.randomSecret();
  await deps.keys.setHash(brokerId, deps.hash(secret));
  return { secret };
}

/**
 * Si el secreto presentado es el vigente del corredor. Un corredor sin secreto, un secreto vacío o
 * uno equivocado dan lo mismo (`false`): quien llama no aprende si el corredor existe.
 */
export async function verifyLeadWebhookSecret(
  deps: Pick<LeadWebhookSecretDeps, "keys" | "hash" | "safeEqual">,
  brokerId: string,
  presented: string | undefined,
): Promise<boolean> {
  const stored = await deps.keys.getHash(brokerId);
  if (stored === null || presented === undefined || presented === "") return false;
  return deps.safeEqual(stored, deps.hash(presented));
}
