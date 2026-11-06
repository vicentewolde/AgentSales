import { stripAccents } from "../extract/spanish.js";
import type { PageText } from "./page-text.js";
import { type DocType, type Extraction, KEYS, TITLE_PATTERN } from "./schema.js";

export interface VerifiedField {
  key: string;
  value: string;
  quote: string;
  page: number;
  /** True only if the value is in the page text and the quote is supported by it. */
  verified: boolean;
  note: string | null;
}

export interface VerifiedDoc {
  doc_type: DocType;
  /** The title line of the document really matches the type the model claimed. */
  type_confirmed: boolean;
  fields: VerifiedField[];
}

const squash = (s: string): string =>
  stripAccents(s.toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Same rule as everywhere else in Aval: no evidence, no claim. A field the model read is kept only if its
 * value really appears on the page it cites and the words of its quote are all there. It uses the PDF's
 * own text layer, which the model never touches, as the independent witness. (A scanned PDF with no
 * text layer cannot be verified this way and every field of it comes back unverified.)
 */
export function verifyExtraction(ex: Extraction, pages: PageText[]): VerifiedDoc {
  const first = squash(`${pages[0]?.raw ?? ""} ${pages[0]?.layout ?? ""}`);
  const type_confirmed = TITLE_PATTERN[ex.doc_type].test(stripAccents(first));
  const allowed = new Set(KEYS[ex.doc_type]);
  const fields: VerifiedField[] = ex.fields.map((f) => {
    const base = { key: f.key, value: f.value.trim(), quote: f.quote.trim(), page: f.page };
    if (!allowed.has(f.key))
      return { ...base, verified: false, note: `"${f.key}" is not a field of this document type` };
    const page = pages[f.page - 1];
    if (!page) return { ...base, verified: false, note: `the document has no page ${f.page}` };
    const hay = [squash(page.raw), squash(page.layout)];
    const value = squash(f.value);
    if (value.length === 0 || !hay.some((h) => h.includes(value)))
      return {
        ...base,
        verified: false,
        note: "the value is not on that page: possible model error",
      };
    const words = squash(f.quote).split(" ").filter(Boolean);
    const present = words.filter((w) => hay.some((h) => ` ${h} `.includes(` ${w} `))).length;
    if (words.length === 0 || present / words.length < 0.9)
      return {
        ...base,
        verified: false,
        note: "the quote is not supported by that page: possible model error",
      };
    return { ...base, verified: true, note: null };
  });
  return { doc_type: ex.doc_type, type_confirmed, fields };
}
