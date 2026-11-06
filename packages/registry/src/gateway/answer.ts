import type { Listing } from "../claims/schema.js";
import { forbiddenStrings, type VisibleFact } from "./policy.js";

export interface AnswerSegment {
  text: string;
  claim_ids: string[];
}

export interface ModelAnswer {
  segments: AnswerSegment[];
  cannot_answer: boolean;
}

/** The language model behind `ask`. It only ever sees facts the policy already allowed. */
export interface AnswerModel {
  answer(input: { question: string; facts: VisibleFact[] }): Promise<ModelAnswer>;
}

export interface AnswerResult {
  answer: string;
  citations: Array<{ claim_id: string; provenance: VisibleFact["provenance"]; evidence: string }>;
  refused: "NO_VERIFIED_FACT" | null;
  /** Things worth a human's attention (injection attempts, blocked leaks). They never change what is allowed. */
  flags: string[];
}

export const MAX_QUESTION_CHARS = 500;
export const REFUSAL = "I can't confirm that from verified facts about this listing.";

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any |the )?(previous|prior|above|earlier)/i, "override-instructions"],
  [/disregard (the |your )?(rules|instructions|policy)/i, "override-instructions"],
  [/(system|developer) (prompt|message|instructions)/i, "probes-system-prompt"],
  [/you are now|act as|pretend (to be|you)|jailbreak|developer mode/i, "role-play"],
  [
    /(reveal|show|print|dump|leak).{0,40}(rules|policy|prompt|hidden|secret|instructions)/i,
    "reveals-internals",
  ],
  [/(exact|full|precise|real).{0,20}(address|location|street)|dirección exacta/i, "asks-address"],
  [
    /(lowest|minimum|floor|bottom|best).{0,20}(price|offer)|precio (mínimo|piso)|exact price/i,
    "asks-price-floor",
  ],
  [/[A-Za-z0-9+/]{60,}={0,2}/, "encoded-payload"],
  [/<\/?(system|assistant|tool|untrusted)/i, "fake-markup"],
];

const GENERIC = new Set(
  `a an to of in on at by as is it be or if so we up do me my our us been being does did done get got such the and are was were has have had with from into onto over under about around also both each only just than then them they their there here this that these those its it's for you your any all can could would should will may might must yes but because since while when where which what who whom whose how why per via
   listing listings apartment flat property home unit place seller sellers broker brokers video clip walkthrough footage seen shown shows show showing visible features feature featured include includes included including located offers offer available availability confirmed confirm confirmation verified verify verification declared declare according states state said say fact facts source sources evidence cited note noted`.split(
    /\s+/,
  ),
);

/** Digits and letters only, so "Av." and "av" compare equal. */
function words(text: string): string[] {
  return (normalize(text).match(/[a-z\u00e0-\u00ff]+|\d+/g) ?? []).map((w) => NUMBER_WORDS[w] ?? w);
}

/**
 * Number words and ordinals count as numbers. Without this, "three bedrooms" cited against "2 bedrooms"
 * and "the first floor" against "Floor 12" slipped through, because the words looked like plain
 * connective words while only digits were checked. They are read as digits on both sides, so
 * "four chairs" and "4 chairs" agree and "three" cannot stand for 2.
 */
const NUMBER_WORDS: Record<string, string> = Object.fromEntries(
  [
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
  ]
    .flatMap((l) => l.split(" "))
    .map((w, i) => [w, String(i)])
    .concat(
      "first second third fourth fifth sixth seventh eighth ninth tenth"
        .split(" ")
        .map((w, i) => [w, String(i + 1)]),
    ),
);

const stem = (w: string): string => (w.length > 4 ? w.replace(/(ies|es|s|ed|ing)$/, "") : w);

/**
 * Cite-washing defense: a sentence may only use words that appear in the facts it cites (or are
 * plain connective words), and every number must come from those facts. A hijacked model that cites
 * a real fact and sneaks "bright", "wardrobe" or "3 bedrooms" into the same sentence is caught here.
 * Failing safe: a paraphrase with a synonym is dropped and the gateway says it cannot confirm.
 */
export function ungroundedTerms(sentence: string, cited: VisibleFact[]): string[] {
  const allowed = new Set<string>();
  // The model is shown each fact's source line too ("seen in the walkthrough video at 7.2s (32 frames)"),
  // which the gateway itself wrote, so its words and numbers are legitimate to repeat.
  for (const f of cited)
    for (const w of words(`${f.statement} ${f.evidence}`))
      allowed.add(/^\d+$/.test(w) ? w : stem(w));
  const bad: string[] = [];
  for (const w of words(sentence)) {
    if (/^\d+$/.test(w)) {
      if (!allowed.has(w)) bad.push(w);
    } else if (!GENERIC.has(w) && !allowed.has(stem(w))) {
      bad.push(w);
    }
  }
  return [...new Set(bad)];
}

/** Lowercases and removes digit separators, so "5.800", "5,800" and "5 800" all read as 5800. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/(?<=\d)[.,\s\u00a0](?=\d)/g, "");
}

export function detectInjection(question: string): string[] {
  const flags = new Set<string>();
  for (const [re, name] of INJECTION_PATTERNS) if (re.test(question)) flags.add(name);
  return [...flags];
}

/**
 * Defense in depth. Layer 1: the model sees only allowed facts. Layer 2 (here): whatever it says is
 * checked in code: every sentence must cite facts that exist and are assertable, and nothing the
 * seller forbids (exact address, exact price under a range policy) may appear in the text.
 * A model that has been fully jailbroken still cannot get past this function.
 */
export async function answerQuestion(args: {
  question: string;
  listing: Listing;
  facts: VisibleFact[];
  model: AnswerModel;
}): Promise<AnswerResult> {
  const question = args.question.slice(0, MAX_QUESTION_CHARS);
  const flags = detectInjection(args.question);
  if (args.question.length > MAX_QUESTION_CHARS) flags.push("question-truncated");
  const byId = new Map(args.facts.map((f) => [f.id, f]));
  const forbidden = forbiddenStrings(args.listing);

  const raw = await args.model.answer({ question, facts: args.facts });
  const kept: AnswerSegment[] = [];
  for (const seg of raw.segments) {
    const ids = seg.claim_ids;
    if (ids.length === 0 || !ids.every((id) => byId.has(id))) {
      flags.push("uncited-or-unknown-claim-dropped");
      continue;
    }
    const lower = normalize(seg.text);
    if (forbidden.some((s) => lower.includes(normalize(s)))) {
      flags.push("forbidden-value-blocked");
      continue;
    }
    const citedFacts = ids.map((id) => byId.get(id) as VisibleFact);
    if (ungroundedTerms(seg.text, citedFacts).length > 0) {
      flags.push("ungrounded-claim-dropped");
      continue;
    }
    kept.push(seg);
  }
  if (raw.cannot_answer || kept.length === 0) {
    return {
      answer: REFUSAL,
      citations: [],
      refused: "NO_VERIFIED_FACT",
      flags: [...new Set(flags)],
    };
  }
  const cited = [...new Set(kept.flatMap((s) => s.claim_ids))];
  return {
    answer: kept.map((s) => s.text.trim()).join(" "),
    citations: cited.map((id) => {
      const f = byId.get(id) as VisibleFact;
      return { claim_id: id, provenance: f.provenance, evidence: f.evidence };
    }),
    refused: null,
    flags: [...new Set(flags)],
  };
}
