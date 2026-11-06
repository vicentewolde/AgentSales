import { z } from "zod";
import type { Listing } from "../claims/schema.js";
import { stripAccents } from "../extract/spanish.js";
import type { Caller, VisibleFact } from "./policy.js";
import { visibleFacts } from "./policy.js";

/**
 * Matching a buyer's criteria against many listings, using ONLY what the seller's policy lets an
 * agent see. It is deterministic on purpose (no model): every verdict names the fact it rests on and
 * where that fact comes from, and "no evidence" is reported as unconfirmed, never as "not met".
 */
export const CriteriaSchema = z.object({
  operation: z.enum(["sale", "rent"]).optional(),
  commune: z.string().min(2).max(60).optional(),
  min_bedrooms: z.number().int().min(0).max(10).optional(),
  min_bathrooms: z.number().int().min(0).max(10).optional(),
  min_area_m2: z.number().positive().max(10000).optional(),
  max_price: z
    .object({ amount: z.number().positive(), currency: z.enum(["UF", "CLP"]) })
    .optional(),
  pets_required: z.boolean().optional(),
  /** Things the buyer wants to see (bathtub, kitchen island, parking, garden...). Each is looked up in the facts. */
  must_have: z.array(z.string().min(2).max(40)).max(8).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

export type Status = "met" | "not_met" | "unconfirmed";

export interface CriterionResult {
  criterion: string;
  status: Status;
  hard: boolean;
  basis: {
    fact_id: string;
    provenance: VisibleFact["provenance"];
    statement: string;
    evidence: string;
  } | null;
  note: string | null;
}

export interface Match {
  listing_id: string;
  title: string;
  commune: string;
  operation: "sale" | "rent";
  fit: "all criteria met" | "some criteria unconfirmed";
  score: number;
  criteria: CriterionResult[];
}

export interface SearchResult {
  matches: Match[];
  excluded: Array<{ listing_id: string; reason: string }>;
  note: string;
}

/** Facts that have their own criterion; everything else (including declared parking or amenities) can satisfy a must-have. */
const STRUCTURED = new Set([
  "d-operation",
  "d-commune",
  "d-price",
  "d-area",
  "d-bedrooms",
  "d-bathrooms",
  "d-pets",
  "d-address",
]);

const WEIGHT: Record<VisibleFact["provenance"], number> = {
  visually_verified: 3,
  broker_stated: 2,
  broker_declared: 1.5,
};

const stem = (w: string): string => (w.length > 4 ? w.replace(/(ies|es|s|ed|ing)$/, "") : w);
const tokens = (s: string): string[] =>
  (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]+/g) ?? []
  ).map(stem);

/**
 * Same word, or one is the start of the other when both have at least 5 letters ("kitchen" finds
 * "kitchenette"; "bed" does not find "bedroom"). A short word must match exactly.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a));
}

function basisOf(f: VisibleFact): NonNullable<CriterionResult["basis"]> {
  return { fact_id: f.id, provenance: f.provenance, statement: f.statement, evidence: f.evidence };
}

function priceBounds(f: VisibleFact): { currency: "UF" | "CLP"; lo: number; hi: number } | null {
  const range = /^Price between (UF|CLP) (\d+) and (?:UF|CLP) (\d+)/.exec(f.statement);
  if (range)
    return { currency: range[1] as "UF" | "CLP", lo: Number(range[2]), hi: Number(range[3]) };
  const exact = /^Price (UF|CLP) (\d+)$/.exec(f.statement);
  if (exact)
    return { currency: exact[1] as "UF" | "CLP", lo: Number(exact[2]), hi: Number(exact[2]) };
  return null;
}

function evaluate(listing: Listing, facts: VisibleFact[], c: Criteria): CriterionResult[] {
  const by = new Map(facts.map((f) => [f.id, f]));
  const out: CriterionResult[] = [];
  const hard = (
    criterion: string,
    status: Status,
    fact: VisibleFact | undefined,
    note: string | null = null,
  ) => out.push({ criterion, status, hard: true, basis: fact ? basisOf(fact) : null, note });

  if (c.operation) {
    const f = by.get("d-operation");
    const op = f?.statement === "For sale" ? "sale" : f?.statement === "For rent" ? "rent" : null;
    hard(
      `operation: ${c.operation}`,
      op === null ? "unconfirmed" : op === c.operation ? "met" : "not_met",
      f,
    );
  }
  if (c.commune) {
    const f = by.get("d-commune");
    const commune = f ? f.statement.replace(/^Located in /, "").toLowerCase() : null;
    hard(
      `commune: ${c.commune}`,
      commune === null
        ? "unconfirmed"
        : stripAccents(commune) === stripAccents(c.commune.toLowerCase())
          ? "met"
          : "not_met",
      f,
    );
  }
  const num = (id: string, re: RegExp): { n: number; f: VisibleFact } | null => {
    const f = by.get(id);
    const m = f && re.exec(f.statement);
    return f && m ? { n: Number(m[1]), f } : null;
  };
  if (c.min_bedrooms !== undefined) {
    const r = num("d-bedrooms", /^(\d+) bedroom/);
    hard(
      `at least ${c.min_bedrooms} bedrooms`,
      r ? (r.n >= c.min_bedrooms ? "met" : "not_met") : "unconfirmed",
      r?.f,
    );
  }
  if (c.min_bathrooms !== undefined) {
    const r = num("d-bathrooms", /^(\d+) bathroom/);
    hard(
      `at least ${c.min_bathrooms} bathrooms`,
      r ? (r.n >= c.min_bathrooms ? "met" : "not_met") : "unconfirmed",
      r?.f,
    );
  }
  if (c.min_area_m2 !== undefined) {
    const r = num("d-area", /^(\d+(?:\.\d+)?) m2/);
    hard(
      `at least ${c.min_area_m2} m2`,
      r ? (r.n >= c.min_area_m2 ? "met" : "not_met") : "unconfirmed",
      r?.f,
    );
  }
  if (c.pets_required) {
    const f = by.get("d-pets");
    hard(
      "pets allowed",
      f === undefined ? "unconfirmed" : f.statement === "Pets allowed" ? "met" : "not_met",
      f,
    );
  }
  if (c.max_price) {
    const f = by.get("d-price");
    const b = f ? priceBounds(f) : null;
    const label = `price up to ${c.max_price.currency} ${c.max_price.amount}`;
    if (!f || !b)
      hard(label, "unconfirmed", f, "The seller does not disclose the price; ask the broker.");
    else if (b.currency !== c.max_price.currency)
      hard(
        label,
        "unconfirmed",
        f,
        `Listed in ${b.currency}, budget is in ${c.max_price.currency}.`,
      );
    else if (b.hi <= c.max_price.amount) hard(label, "met", f);
    else if (b.lo > c.max_price.amount) hard(label, "not_met", f);
    else
      hard(label, "unconfirmed", f, `The approximate range ${b.lo}-${b.hi} straddles the budget.`);
  }
  for (const want of c.must_have ?? []) {
    const wt = tokens(want);
    const hits = facts.filter((f) => {
      if (STRUCTURED.has(f.id)) return false;
      const ft = tokens(f.statement);
      return wt.every((t) => ft.some((x) => sameWord(t, x)));
    });
    hits.sort((a, b) => WEIGHT[b.provenance] - WEIGHT[a.provenance]);
    const best = hits[0];
    out.push(
      best
        ? { criterion: `has ${want}`, status: "met", hard: false, basis: basisOf(best), note: null }
        : {
            criterion: `has ${want}`,
            status: "unconfirmed",
            hard: false,
            basis: null,
            note: "No verified or stated fact mentions it. That does not mean it is absent.",
          },
    );
  }
  void listing;
  return out;
}

export function searchListings(
  listings: Listing[],
  caller: Caller,
  criteria: Criteria,
): SearchResult {
  const matches: Match[] = [];
  const excluded: SearchResult["excluded"] = [];
  for (const listing of listings) {
    let facts: VisibleFact[];
    try {
      facts = visibleFacts(listing, caller);
    } catch {
      continue; // this seller does not serve this caller; its existence is not revealed
    }
    const criteriaResults = evaluate(listing, facts, criteria);
    const failed = criteriaResults.find((r) => r.hard && r.status === "not_met");
    if (failed) {
      excluded.push({
        listing_id: listing.id,
        reason: `${failed.criterion}: ${failed.basis?.statement ?? "not met"}`,
      });
      continue;
    }
    const unconfirmed = criteriaResults.filter((r) => r.status === "unconfirmed").length;
    const score = criteriaResults.reduce(
      (s, r) =>
        s + (r.status === "met" ? (r.hard ? 2 : r.basis ? WEIGHT[r.basis.provenance] : 0) : 0),
      0,
    );
    matches.push({
      listing_id: listing.id,
      title: listing.declared.title,
      commune: listing.declared.commune,
      operation: listing.declared.operation,
      fit: unconfirmed === 0 ? "all criteria met" : "some criteria unconfirmed",
      score,
      criteria: criteriaResults,
    });
  }
  // What the buyer cannot compromise on comes first: a listing whose HARD criterion (budget, bedrooms,
  // pets...) is unconfirmed ranks below one whose only gap is a nice-to-have, whatever the evidence score.
  const gaps = (m: Match, hard: boolean): number =>
    m.criteria.filter((c) => c.status === "unconfirmed" && c.hard === hard).length;
  matches.sort(
    (a, b) => gaps(a, true) - gaps(b, true) || gaps(a, false) - gaps(b, false) || b.score - a.score,
  );
  return {
    matches: matches.slice(0, criteria.limit ?? 5),
    excluded,
    note: "Only verified, broker-stated and broker-declared facts were used. 'unconfirmed' means no evidence either way; ask the gateway or the broker before assuming.",
  };
}
