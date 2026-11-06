import { createHash } from "node:crypto";

/** JSON with sorted keys: the same value always serializes to the same bytes, so hashes and signatures are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Domain-separated, so a leaf can never be mistaken for an inner node. */
export const leafHash = (value: unknown): string => sha256(`leaf:${canonicalJson(value)}`);
const nodeHash = (l: string, r: string): string => sha256(`node:${l}:${r}`);

export interface ProofStep {
  sibling: string;
  /** Where the sibling sits relative to the running hash. */
  side: "left" | "right";
}

function levels(leaves: string[]): string[][] {
  if (leaves.length === 0) return [[sha256("empty")]];
  const out: string[][] = [leaves];
  while ((out.at(-1) as string[]).length > 1) {
    const cur = out.at(-1) as string[];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2)
      next.push(nodeHash(cur[i] as string, (cur[i + 1] ?? cur[i]) as string));
    out.push(next);
  }
  return out;
}

export function merkleRoot(leaves: string[]): string {
  return (levels(leaves).at(-1) as string[])[0] as string;
}

/** Proof that the leaf at `index` is part of the tree, without revealing any other leaf. */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const proof: ProofStep[] = [];
  let i = index;
  const lv = levels(leaves);
  for (const level of lv.slice(0, -1)) {
    const isRight = i % 2 === 1;
    const sib = isRight ? i - 1 : i + 1;
    proof.push({ sibling: (level[sib] ?? level[i]) as string, side: isRight ? "left" : "right" });
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: ProofStep[], root: string): boolean {
  let h = leaf;
  for (const step of proof)
    h = step.side === "left" ? nodeHash(step.sibling, h) : nodeHash(h, step.sibling);
  return h === root;
}
