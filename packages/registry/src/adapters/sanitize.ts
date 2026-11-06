import { detectInjection } from "../gateway/answer.js";

/**
 * In a marketplace the SELLER can be the attacker. Whatever a seller writes ends up as a "fact" that
 * a language model reads and an agent repeats, so seller text is screened before it becomes a claim:
 * instructions aimed at models, promotional or taste language, and contact details or links are
 * rejected (and reported), never silently kept.
 */
const TASTE =
  /\b(best|luxur\w*|stunning|amazing|perfect|ideal|dream|steal|bargain|unbeatable|must[- ]see|exclusive|incredible|spectacular|gorgeous|great|beautiful|cozy|charming|spacious|bright|quiet|safe|investment|imperdible|oportunidad|espectacular|lujo\w*|increible|hermos\w*|mejor)\b/i;
const CONTACT =
  /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.\w+|\+?\d[\d\s().-]{7,}\d|whatsapp|call me|contact me|llamame|llama al)/i;

export const hasTasteWord = (text: string): boolean => TASTE.test(text);
export const hasContactDetails = (text: string): boolean => CONTACT.test(text);

export interface Rejection {
  field: string;
  value: string;
  reason:
    | "instruction aimed at a model"
    | "taste or promotional word"
    | "contact details or link"
    | "too long or empty";
}

export function screenSellerText(field: string, value: string, maxLen = 60): Rejection | null {
  const v = value.trim();
  const reject = (reason: Rejection["reason"]): Rejection => ({
    field,
    value: v.slice(0, 80),
    reason,
  });
  if (v.length === 0 || v.length > maxLen) return reject("too long or empty");
  if (
    detectInjection(v).length > 0 ||
    /(ignore|disregard|olvida|ignora)\b.*\b(rules?|instructions?|reglas|instrucciones)/i.test(v)
  )
    return reject("instruction aimed at a model");
  if (CONTACT.test(v)) return reject("contact details or link");
  if (TASTE.test(v)) return reject("taste or promotional word");
  return null;
}
