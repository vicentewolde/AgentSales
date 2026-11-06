import { detectInjection } from "../gateway/answer.js";
import { canonicalJson, sha256 } from "../passport/merkle.js";
import {
  type BuyerMandate,
  CONDITIONS,
  type Condition,
  mandateCommitment,
  type SellerMandate,
} from "./mandate.js";

/**
 * The negotiation engine is the only authority. Two language-model agents may say anything they like
 * in prose, but a move only exists once the engine accepts it, and the engine checks it against the
 * signed mandates in code: price within authority, concessions only in the right direction, terms within
 * the allowed range, a hard limit on rounds, and a text channel that carries no numbers at all, so a
 * hijacked or flattering agent has no way to leak its principal's limit.
 */
export type Party = "buyer" | "seller";

export type Action =
  | {
      type: "offer";
      price: number;
      closing_days: number;
      conditions: Condition[];
      rationale: string;
    }
  | { type: "accept"; rationale?: string }
  | { type: "walk_away"; rationale?: string };

export interface Move {
  seq: number;
  party: Party;
  type: "offer" | "accept" | "walk_away";
  price?: number;
  closing_days?: number;
  conditions?: Condition[];
  rationale: string;
  at: string;
  flags: string[];
  prev_hash: string;
  hash: string;
}

export interface Agreement {
  price: number;
  currency: "UF" | "CLP";
  closing_days: number;
  conditions: Condition[];
  agreed_at: string;
  proposed_by: Party;
}

export interface NegotiationState {
  id: string;
  listing_id: string;
  currency: "UF" | "CLP";
  created_at: string;
  status: "open" | "agreed" | "walked_away" | "no_deal";
  turn: Party;
  moves: Move[];
  agreement?: Agreement;
  buyer_commitment: string;
  seller_commitment: string;
}

export interface Mandates {
  buyer: BuyerMandate;
  seller: SellerMandate;
}

export type EngineResult =
  | { ok: true; state: NegotiationState }
  | { ok: false; code: EngineErrorCode; message: string };

export type EngineErrorCode =
  | "NEGOTIATION_CLOSED"
  | "NOT_YOUR_TURN"
  | "MANDATE_EXPIRED"
  | "ROUND_LIMIT"
  | "OVER_AUTHORITY"
  | "UNDER_AUTHORITY"
  | "NOT_A_CONCESSION"
  | "ABOVE_ASKING"
  | "CLOSING_DAYS_NOT_ALLOWED"
  | "CONDITION_NOT_ALLOWED"
  | "RATIONALE_REJECTED"
  | "NOTHING_TO_ACCEPT"
  | "ACCEPT_OUTSIDE_AUTHORITY"
  | "BAD_ACTION";

const GENESIS = "0".repeat(64);
const MAX_RATIONALE = 240;

/** Number words in English and Spanish. The text channel may not contain any, nor digits. */
const NUMBER_WORD =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|percent|cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[a-z]*|veint[a-z]*|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|[a-z]*cientos|[a-z]*cientas|mil|millon|millones|por ciento)\b/i;

export function checkRationale(
  text: string,
): { ok: true; clean: string; flags: string[] } | { ok: false; reason: string } {
  const clean = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: quitar los caracteres de control es el propósito
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > MAX_RATIONALE)
    return { ok: false, reason: `the rationale is longer than ${MAX_RATIONALE} characters` };
  const ascii = clean.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/[0-9٠-٩۰-۹０-９]/.test(ascii))
    return {
      ok: false,
      reason: "the rationale may not contain digits: figures go in the offer, never in the text",
    };
  if (NUMBER_WORD.test(ascii))
    return {
      ok: false,
      reason:
        "the rationale may not contain number words: figures go in the offer, never in the text",
    };
  return { ok: true, clean, flags: detectInjection(clean) };
}

const fail = (code: EngineErrorCode, message: string): EngineResult => ({
  ok: false,
  code,
  message,
});

export function newNegotiation(id: string, m: Mandates, now: Date): NegotiationState {
  return {
    id,
    listing_id: m.seller.listing_id,
    currency: m.seller.currency,
    created_at: now.toISOString(),
    status: "open",
    turn: "buyer",
    moves: [],
    buyer_commitment: mandateCommitment(m.buyer),
    seller_commitment: mandateCommitment(m.seller),
  };
}

const offersBy = (s: NegotiationState, p: Party) =>
  s.moves.filter((x) => x.party === p && x.type === "offer");

/** What each side currently stands behind: the seller's last counter (or the asking price), the buyer's last offer. */
export function standing(
  s: NegotiationState,
  m: Mandates,
): { seller: number; buyer: number | null } {
  const sellerLast = offersBy(s, "seller").at(-1);
  const buyerLast = offersBy(s, "buyer").at(-1);
  return { seller: sellerLast?.price ?? m.seller.asking, buyer: buyerLast?.price ?? null };
}

function mandateOf(m: Mandates, p: Party): BuyerMandate | SellerMandate {
  return p === "buyer" ? m.buyer : m.seller;
}

function append(
  s: NegotiationState,
  move: Omit<Move, "seq" | "prev_hash" | "hash">,
): NegotiationState {
  const prev = s.moves.at(-1)?.hash ?? GENESIS;
  const base = { ...move, seq: s.moves.length + 1, prev_hash: prev };
  const hash = sha256(`move:${canonicalJson(base)}`);
  return { ...s, moves: [...s.moves, { ...base, hash }] };
}

export function verifyMoves(s: NegotiationState): boolean {
  let prev = GENESIS;
  for (const [i, mv] of s.moves.entries()) {
    const { hash, ...rest } = mv;
    if (mv.seq !== i + 1 || mv.prev_hash !== prev || sha256(`move:${canonicalJson(rest)}`) !== hash)
      return false;
    prev = hash;
  }
  return true;
}

export function applyAction(
  state: NegotiationState,
  m: Mandates,
  party: Party,
  action: Action,
  now: Date,
): EngineResult {
  if (state.status !== "open") return fail("NEGOTIATION_CLOSED", "This negotiation is closed.");
  if (state.turn !== party) return fail("NOT_YOUR_TURN", "It is not your turn.");
  const mine = mandateOf(m, party);
  if (now.getTime() > Date.parse(mine.expires_at))
    return fail("MANDATE_EXPIRED", "Your mandate has expired. Ask your principal for a new one.");
  const other: Party = party === "buyer" ? "seller" : "buyer";
  const stand = standing(state, m);

  if (action.type === "walk_away") {
    const r = checkRationale(action.rationale ?? "");
    if (!r.ok) return fail("RATIONALE_REJECTED", r.reason);
    return {
      ok: true,
      state: {
        ...append(state, {
          party,
          type: "walk_away",
          rationale: r.clean,
          at: now.toISOString(),
          flags: r.flags,
        }),
        status: "walked_away",
      },
    };
  }

  if (action.type === "accept") {
    const r = checkRationale(action.rationale ?? "");
    if (!r.ok) return fail("RATIONALE_REJECTED", r.reason);
    const theirs = offersBy(state, other).at(-1);
    // Accepting the standing ask is allowed for a buyer who has seen no counter: it is the public asking price.
    const price = party === "buyer" ? stand.seller : theirs?.price;
    if (price === undefined)
      return fail("NOTHING_TO_ACCEPT", "There is no offer from the other side to accept.");
    if (party === "buyer" && price > m.buyer.max)
      return fail(
        "ACCEPT_OUTSIDE_AUTHORITY",
        "Accepting that price is outside what your principal authorized.",
      );
    if (party === "seller" && price < m.seller.floor)
      return fail(
        "ACCEPT_OUTSIDE_AUTHORITY",
        "Accepting that price is outside what your principal authorized.",
      );
    const days = theirs?.closing_days ?? (mine.closing_days.min + mine.closing_days.max) >> 1;
    if (days < mine.closing_days.min || days > mine.closing_days.max)
      return fail(
        "CLOSING_DAYS_NOT_ALLOWED",
        "That closing period is outside what your principal authorized.",
      );
    const conditions = theirs?.conditions ?? [];
    return conclude(
      append(state, {
        party,
        type: "accept",
        rationale: r.clean,
        at: now.toISOString(),
        flags: r.flags,
      }),
      price,
      days,
      conditions,
      party,
      now,
    );
  }

  if (action.type !== "offer") return fail("BAD_ACTION", "Unknown action.");
  const used = offersBy(state, party).length;
  if (used >= mine.max_rounds)
    return fail("ROUND_LIMIT", "You have used all your rounds; you can only accept or walk away.");
  const price = action.price;
  if (!Number.isFinite(price) || price <= 0)
    return fail("BAD_ACTION", "The price must be a positive number.");
  const prev = offersBy(state, party).at(-1)?.price;
  if (party === "buyer") {
    if (price > m.buyer.max)
      return fail("OVER_AUTHORITY", "That offer is above what your principal authorized.");
    if (prev !== undefined && price < prev)
      return fail(
        "NOT_A_CONCESSION",
        "An offer cannot go backwards: a buyer may only raise their own previous offer.",
      );
  } else {
    if (price < m.seller.floor)
      return fail("UNDER_AUTHORITY", "That counter is below what your principal authorized.");
    if (price > (prev ?? m.seller.asking))
      return fail("ABOVE_ASKING", "A counter cannot be higher than your own previous position.");
  }
  if (action.closing_days < mine.closing_days.min || action.closing_days > mine.closing_days.max)
    return fail(
      "CLOSING_DAYS_NOT_ALLOWED",
      "That closing period is outside what your principal authorized.",
    );
  if (
    action.conditions.some((c) => !mine.allowed_conditions.includes(c)) ||
    action.conditions.some((c) => !CONDITIONS.includes(c))
  )
    return fail("CONDITION_NOT_ALLOWED", "One of those conditions is not authorized.");
  const r = checkRationale(action.rationale);
  if (!r.ok) return fail("RATIONALE_REJECTED", r.reason);
  const next = append(state, {
    party,
    type: "offer",
    price,
    closing_days: action.closing_days,
    conditions: action.conditions,
    rationale: r.clean,
    at: now.toISOString(),
    flags: r.flags,
  });
  // A deal happens when one side's offer meets what the other already stands behind.
  if (
    party === "buyer" &&
    price >= stand.seller &&
    acceptableDays(m.seller, action.closing_days) &&
    action.conditions.every((c) => m.seller.allowed_conditions.includes(c))
  ) {
    return conclude(next, stand.seller, action.closing_days, action.conditions, "buyer", now);
  }
  if (party === "seller" && stand.buyer !== null && price <= stand.buyer) {
    const bo = offersBy(state, "buyer").at(-1);
    if (bo?.closing_days !== undefined && acceptableDays(m.seller, bo.closing_days))
      return conclude(next, stand.buyer, bo.closing_days, bo.conditions ?? [], "buyer", now);
  }
  return { ok: true, state: { ...next, turn: other } };
}

const acceptableDays = (m: BuyerMandate | SellerMandate, d: number): boolean =>
  d >= m.closing_days.min && d <= m.closing_days.max;

function conclude(
  s: NegotiationState,
  price: number,
  days: number,
  conditions: Condition[],
  by: Party,
  now: Date,
): EngineResult {
  return {
    ok: true,
    state: {
      ...s,
      status: "agreed",
      agreement: {
        price,
        currency: s.currency,
        closing_days: days,
        conditions: [...new Set(conditions)],
        agreed_at: now.toISOString(),
        proposed_by: by,
      },
    },
  };
}

/** True when the party to move cannot make progress any more: no rounds left and nothing it may accept. */
export function stalled(state: NegotiationState, m: Mandates): boolean {
  if (state.status !== "open") return false;
  const mine = mandateOf(m, state.turn);
  if (offersBy(state, state.turn).length < mine.max_rounds) return false;
  const st = standing(state, m);
  if (state.turn === "buyer") return st.seller > m.buyer.max;
  const lastBuyer = offersBy(state, "buyer").at(-1)?.price;
  return lastBuyer === undefined || lastBuyer < m.seller.floor;
}

export function closeStalled(state: NegotiationState, m: Mandates, now: Date): NegotiationState {
  return stalled(state, m)
    ? {
        ...state,
        status: "no_deal",
        moves: append(state, {
          party: state.turn,
          type: "walk_away",
          rationale: "No rounds left and no acceptable position.",
          at: now.toISOString(),
          flags: ["auto-closed"],
        }).moves,
      }
    : state;
}
