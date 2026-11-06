import { createHash } from "node:crypto";
import { ASSERTABLE, type Claim, type Listing, type Policy } from "../claims/schema.js";

export type Tier = "verified" | "anonymous";

export interface Caller {
  agentId: string | null;
  tier: Tier;
}

/** What an agent may be told about one claim: the statement and where it comes from, no internals. */
export interface VisibleFact {
  id: string;
  statement: string;
  provenance: "visually_verified" | "broker_stated" | "broker_declared";
  evidence: string;
}

export class PolicyDenied extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** Stable pseudo-random number in [0.5, 1.5) from a seed (the listing id), so ranges do not change between calls. */
function jitter(seed: string): number {
  const h = createHash("sha256").update(seed).digest();
  return 0.5 + h.readUInt16BE(0) / 65536;
}

/**
 * An approximate price range that contains the real price but is deliberately NOT centered on it.
 * A symmetric range leaks the exact price to anyone who asks for the midpoint (the red-team found
 * exactly that attack), so each side gets its own listing-specific width.
 */
export function priceRange(
  amount: number,
  currency: "UF" | "CLP",
  pct: number,
  seed: string,
): [number, number] {
  const step = currency === "UF" ? 1 : 10_000;
  const down = pct * jitter(`${seed}:lo`);
  let up = pct * jitter(`${seed}:hi`);
  if (Math.abs(up - down) < pct * 0.25) up = down + pct * 0.35;
  const lo = roundTo(amount * (1 - down), step);
  let hi = roundTo(amount * (1 + up), step);
  if (Math.abs((lo + hi) / 2 - amount) < amount * 0.01)
    hi = roundTo(amount * (1 + up + 0.03), step);
  return [Math.min(lo, amount - step), Math.max(hi, amount + step)];
}

function evidenceText(c: Claim): string {
  if (c.evidence?.kind === "visual") {
    const t = c.evidence.t_sec === null ? "" : ` at ${c.evidence.t_sec.toFixed(1)}s`;
    return `seen in the walkthrough video${t} (${c.evidence.frames_detected} frames)`;
  }
  if (c.evidence?.kind === "voice") {
    const t = c.evidence.t_sec === null ? "" : ` around ${c.evidence.t_sec.toFixed(0)}s`;
    return `said by the broker in a voice note${t}: "${c.evidence.quote ?? ""}"; not independently verified`;
  }
  return "declared by the broker; not independently verified";
}

/**
 * The only door between the ledger and an agent. Applies the seller's policy to the *claims*, so the
 * answering model is never shown what it may not say (least privilege by construction).
 */
export function visibleFacts(listing: Listing, caller: Caller): VisibleFact[] {
  assertMayRead(listing.policy, caller);
  const p = listing.policy;
  const out: VisibleFact[] = [];
  for (const c of listing.claims) {
    if (!ASSERTABLE.has(c.provenance)) continue;
    if (c.id === "d-address" && !p.showExactAddress) continue;
    let statement = c.statement;
    if (c.id === "d-price") {
      if (p.priceVisibility === "hidden") continue;
      if (p.priceVisibility === "range") {
        const m = /^Price (UF|CLP) ([\d.]+)$/.exec(c.statement);
        if (!m) continue;
        const [lo, hi] = priceRange(
          Number(m[2]),
          m[1] as "UF" | "CLP",
          p.priceRangePct,
          listing.id,
        );
        statement = `Price between ${m[1]} ${lo} and ${m[1]} ${hi} (approximate range set by the seller)`;
      }
    }
    out.push({
      id: c.id,
      statement,
      provenance: c.provenance as VisibleFact["provenance"],
      evidence: evidenceText(c),
    });
  }
  return out;
}

export function assertMayRead(policy: Policy, caller: Caller): void {
  if (caller.tier === "anonymous" && !policy.allowAnonymousAgents) {
    throw new PolicyDenied(
      "AGENT_NOT_IDENTIFIED",
      "This seller only serves agents that identify themselves.",
    );
  }
}

export function assertMayRequestVisit(policy: Policy, caller: Caller): void {
  if (caller.tier !== "verified") {
    throw new PolicyDenied("AGENT_NOT_IDENTIFIED", "Visit requests need an identified agent.");
  }
  if (policy.visitSlots.length === 0) {
    throw new PolicyDenied("NO_VISIT_SLOTS", "The seller has not opened visit slots.");
  }
}

/** Strings that must never appear in an answer: the exact address and, with a range, the exact price. */
export function forbiddenStrings(listing: Listing): string[] {
  const out: string[] = [];
  const p = listing.policy;
  if (!p.showExactAddress) {
    const a = listing.claims.find((c) => c.id === "d-address");
    const m = a && /^Address: (.+)$/.exec(a.statement);
    if (m?.[1]) out.push(m[1]);
    if (listing.declared.address) out.push(listing.declared.address);
  }
  if (p.priceVisibility !== "exact") {
    const n = listing.declared.price.amount;
    out.push(String(n), n.toLocaleString("en-US"), n.toLocaleString("es-CL"));
  }
  return [...new Set(out.filter((s) => s.length >= 3))];
}
