import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256 } from "../passport/merkle.js";

/**
 * A mandate is what a human principal authorizes an agent to do: the limits that code, not the model,
 * enforces. It is signed with the principal's key, so an agent cannot widen its own authority and the
 * other side can later check that a term sheet respected both mandates without ever seeing them: each
 * mandate carries a random salt and only its salted hash is published.
 */
export const CONDITIONS = [
  "subject_to_title_review",
  "subject_to_financing_approval",
  "furnishings_included",
] as const;
export type Condition = (typeof CONDITIONS)[number];

const common = {
  id: z.string().min(1).max(80),
  listing_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** The key id of the human (or firm) that signs this mandate. */
  principal: z.string().min(1).max(60),
  currency: z.enum(["UF", "CLP"]),
  max_rounds: z.number().int().min(1).max(12),
  allowed_conditions: z.array(z.enum(CONDITIONS)),
  issued_at: z.string(),
  expires_at: z.string(),
  salt: z.string().length(32),
};
const range = z
  .object({ min: z.number().int().min(0).max(365), max: z.number().int().min(0).max(365) })
  .refine((r) => r.min <= r.max);

export const SellerMandateSchema = z
  .object({
    ...common,
    kind: z.literal("seller"),
    asking: z.number().positive(),
    /** SECRET: the lowest price the seller authorizes. Never published, never in the listing. */
    floor: z.number().positive(),
    closing_days: range,
  })
  .refine((m) => m.floor <= m.asking, { message: "floor cannot exceed asking" });

export const BuyerMandateSchema = z
  .object({
    ...common,
    kind: z.literal("buyer"),
    /** The agent (registered signing identity) this mandate is for. */
    agent_id: z.string().min(1).max(80),
    target: z.number().positive(),
    /** SECRET: the most the buyer authorizes. */
    max: z.number().positive(),
    closing_days: range,
  })
  .refine((m) => m.target <= m.max, { message: "target cannot exceed max" });

export type SellerMandate = z.infer<typeof SellerMandateSchema>;
export type BuyerMandate = z.infer<typeof BuyerMandateSchema>;
export type Mandate = SellerMandate | BuyerMandate;

export interface SignedMandate<M extends Mandate = Mandate> {
  mandate: M;
  signature: string;
}

export const newSalt = (): string => randomBytes(16).toString("hex");

export function signMandate<M extends Mandate>(
  mandate: M,
  privateKeyPem: string,
): SignedMandate<M> {
  return {
    mandate,
    signature: sign(
      null,
      Buffer.from(canonicalJson(mandate)),
      createPrivateKey(privateKeyPem),
    ).toString("base64"),
  };
}

/** Salted hash: commits to the mandate (to prove later it was respected) without revealing the limits. */
export const mandateCommitment = (m: Mandate): string => sha256(`mandate:${canonicalJson(m)}`);

export class PrincipalRegistry {
  private readonly keys = new Map<string, string>();

  constructor(records: Array<{ id: string; publicKey: string }>) {
    for (const r of records) this.keys.set(r.id, r.publicKey);
  }

  publicKeyOf(id: string): string | undefined {
    return this.keys.get(id);
  }

  /** True only if the mandate is well-formed, signed by its own principal's registered key, and unexpired. */
  verify(signed: SignedMandate, now = new Date()): { ok: true } | { ok: false; reason: string } {
    const schema = signed.mandate.kind === "seller" ? SellerMandateSchema : BuyerMandateSchema;
    const parsed = schema.safeParse(signed.mandate);
    if (!parsed.success) return { ok: false, reason: "the mandate is malformed" };
    const pub = this.keys.get(signed.mandate.principal);
    if (!pub) return { ok: false, reason: "unknown principal" };
    try {
      const key = createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
      if (
        !verify(
          null,
          Buffer.from(canonicalJson(signed.mandate)),
          key,
          Buffer.from(signed.signature, "base64"),
        )
      )
        return { ok: false, reason: "bad signature" };
    } catch {
      return { ok: false, reason: "bad signature" };
    }
    if (now.getTime() > Date.parse(signed.mandate.expires_at))
      return { ok: false, reason: "the mandate has expired" };
    if (now.getTime() < Date.parse(signed.mandate.issued_at) - 5 * 60_000)
      return { ok: false, reason: "the mandate is dated in the future" };
    return { ok: true };
  }
}
