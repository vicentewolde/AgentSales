import type { Listing } from "../claims/schema.js";
import { stripAccents } from "../extract/spanish.js";
import { type DocType, REQUIRED_DOCS, type SellerIdentity } from "./schema.js";
import type { VerifiedDoc } from "./verify.js";

export type Severity = "blocker" | "warning" | "info";

export interface Finding {
  severity: Severity;
  rule: string;
  message: string;
  /** Which documents and fields the finding rests on (type, key, page, quote). Never a bare assertion. */
  evidence: Array<{ doc_type: DocType; key: string; page: number; quote: string }>;
}

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

export function parseDate(text: string): Date | null {
  const t = stripAccents(text.toLowerCase());
  const long = /(\d{1,2})\s+de\s+([a-z]+)\s+(?:de|del)\s+(\d{4})/.exec(t);
  if (long && MONTHS[long[2] as string])
    return new Date(
      Date.UTC(Number(long[3]), (MONTHS[long[2] as string] as number) - 1, Number(long[1])),
    );
  const num = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(t);
  if (num) return new Date(Date.UTC(Number(num[3]), Number(num[2]) - 1, Number(num[1])));
  return null;
}

/** "$ 148.320" -> 148320; "no registra deuda" -> 0; anything else -> null (never guess). */
export function parseMoney(text: string): number | null {
  const t = stripAccents(text.toLowerCase());
  const m = /\$\s*([\d.]+)/.exec(t) ?? /suma de\s+([\d.]+)/.exec(t);
  if (m?.[1]) return Number(m[1].replace(/\./g, ""));
  if (/no registra( deuda)?|sin deuda|no mantiene deuda/.test(t)) return 0;
  return null;
}

const nameTokens = (s: string): string[] =>
  stripAccents(s.toLowerCase())
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .sort();
export const normRut = (s: string): string => s.replace(/[^0-9kK]/g, "").toUpperCase();
const sameName = (a: string, b: string): boolean =>
  JSON.stringify(nameTokens(a)) === JSON.stringify(nameTokens(b));
const normRol = (s: string): string => s.replace(/[^0-9]/g, "");

const verified = (docs: VerifiedDoc[], type: DocType, key: string) =>
  docs
    .filter((d) => d.doc_type === type && d.type_confirmed)
    .flatMap((d) =>
      d.fields
        .filter((f) => f.key === key && f.verified)
        .map((f) => ({ doc_type: type, key, page: f.page, quote: f.quote, value: f.value })),
    );
const ev = (rows: Array<{ doc_type: DocType; key: string; page: number; quote: string }>) =>
  rows.map(({ doc_type, key, page, quote }) => ({ doc_type, key, page, quote }));

export const STALE_AFTER_DAYS = 30;

/**
 * Cross-checks between what the documents say and what the listing and the seller say. Deterministic:
 * the model only reads; these rules decide. Anything that could not be verified against the PDF text is
 * reported as unconfirmed, never assumed either way.
 */
export function runRules(
  docs: VerifiedDoc[],
  seller: SellerIdentity,
  listing: Listing,
  now: Date,
): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const present = new Set(docs.filter((d) => d.type_confirmed).map((d) => d.doc_type));

  for (const d of docs) {
    if (!d.type_confirmed)
      add({
        severity: "warning",
        rule: "DOC_TYPE_UNCONFIRMED",
        message: `A document was read as ${d.doc_type} but its title does not say so; it was not used.`,
        evidence: [],
      });
    for (const f of d.fields.filter((x) => !x.verified))
      add({
        severity: "warning",
        rule: "FIELD_NOT_VERIFIED",
        message: `"${f.key}" in ${d.doc_type} could not be verified against the PDF text (${f.note}); it was not used.`,
        evidence: [],
      });
  }
  for (const t of REQUIRED_DOCS)
    if (!present.has(t))
      add({
        severity: "warning",
        rule: "DOC_MISSING",
        message: `Missing document: ${t}.`,
        evidence: [],
      });

  // 1. The owner on the title must be the person selling.
  const owners = verified(docs, "certificado_dominio", "propietario");
  const ruts = verified(docs, "certificado_dominio", "rut_propietario");
  if (owners.length > 0) {
    const nameOk = owners.some((o) => sameName(o.value, seller.legal_name));
    const rutOk =
      ruts.length === 0 ? null : ruts.some((r) => normRut(r.value) === normRut(seller.rut));
    if (!nameOk || rutOk === false) {
      add({
        severity: "blocker",
        rule: "OWNER_IS_NOT_SELLER",
        message:
          "The owner on the certificate of title is not the person selling, so this seller cannot sell it. This is also the classic sign of a forged or reused document.",
        evidence: ev([...owners, ...ruts]),
      });
    } else {
      add({
        severity: "info",
        rule: "OWNER_MATCHES_SELLER",
        message: "The owner on the title matches the seller's name and RUT.",
        evidence: ev([...owners, ...ruts]),
      });
    }
  }

  // 2. The property described is the one listed.
  const inm = verified(docs, "certificado_dominio", "inmueble");
  if (inm[0]) {
    const text = stripAccents(inm[0].value.toLowerCase());
    const communeOk = text.includes(stripAccents(listing.declared.commune.toLowerCase()));
    const street =
      stripAccents((listing.declared.address ?? "").toLowerCase())
        .replace(/\(.*?\)/g, "")
        .split(",")[0] ?? "";
    const streetWords = street
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !/^(avenida|calle|pasaje)$/.test(w));
    const streetNumber = /\d{2,}/.exec(street)?.[0];
    const streetOk =
      streetWords.length === 0
        ? true
        : streetWords.every((w) => text.includes(w)) &&
          (!streetNumber || text.includes(streetNumber));
    if (!communeOk || !streetOk)
      add({
        severity: "blocker",
        rule: "PROPERTY_MISMATCH",
        message:
          "The property described on the certificate does not match the listing's commune and street.",
        evidence: ev(inm),
      });
    else
      add({
        severity: "info",
        rule: "PROPERTY_MATCHES_LISTING",
        message: "The commune and street on the certificate match the listing.",
        evidence: ev(inm),
      });
  }

  // 3. The cadastral rol must be the same on every document.
  const rols = (
    ["certificado_dominio", "certificado_gravamenes", "certificado_contribuciones"] as const
  ).flatMap((t) => verified(docs, t, "rol_avaluo"));
  if (new Set(rols.map((r) => normRol(r.value))).size > 1)
    add({
      severity: "blocker",
      rule: "ROL_INCONSISTENT",
      message: "The rol de avaluo differs between documents: they describe different properties.",
      evidence: ev(rols),
    });
  else if (rols.length > 1)
    add({
      severity: "info",
      rule: "ROL_CONSISTENT",
      message: "The rol de avaluo is the same on every document.",
      evidence: ev(rols),
    });

  // 4. Encumbrances.
  const grav = verified(docs, "certificado_gravamenes", "gravamen");
  const none = verified(docs, "certificado_gravamenes", "sin_gravamenes");
  for (const g of grav) {
    const t = stripAccents(g.value.toLowerCase());
    if (/prohibicion|embargo|litigio|demanda|medida precautoria/.test(t))
      add({
        severity: "blocker",
        rule: "ENCUMBRANCE_BLOCKS_SALE",
        message:
          "There is a prohibition, embargo or court order registered on the property: it cannot be sold until a court lifts it.",
        evidence: ev([g]),
      });
    else if (/hipoteca/.test(t))
      add({
        severity: "warning",
        rule: "MORTGAGE_REGISTERED",
        message:
          "A mortgage is registered. It must be paid off and lifted (alzamiento) at closing, or the buyer assumes it. A lawyer should handle this.",
        evidence: ev([g]),
      });
    else
      add({
        severity: "warning",
        rule: "OTHER_ENCUMBRANCE",
        message:
          "Another encumbrance is registered (for example an easement or usufruct). Review it with a lawyer.",
        evidence: ev([g]),
      });
  }
  if (
    grav.length === 0 &&
    none[0] &&
    /no registra|sin gravamenes/.test(stripAccents(none[0].value.toLowerCase()))
  )
    add({
      severity: "info",
      rule: "NO_ENCUMBRANCES",
      message: "The certificate says there are no mortgages, prohibitions or embargoes.",
      evidence: ev(none),
    });
  if (grav.length === 0 && none.length === 0 && present.has("certificado_gravamenes"))
    add({
      severity: "warning",
      rule: "ENCUMBRANCES_UNCONFIRMED",
      message:
        "The encumbrances certificate could not be read with enough certainty to say either way.",
      evidence: [],
    });

  // 5. Debts.
  for (const [type, label] of [
    ["certificado_contribuciones", "property tax (contribuciones)"],
    ["certificado_gastos_comunes", "common expenses"],
  ] as const) {
    const d = verified(docs, type, "deuda")[0];
    if (!d) continue;
    const amount = parseMoney(d.value);
    if (amount === null)
      add({
        severity: "warning",
        rule: "DEBT_UNCONFIRMED",
        message: `The ${label} amount could not be read with certainty.`,
        evidence: ev([d]),
      });
    else if (amount > 0)
      add({
        severity: "warning",
        rule: "DEBT_OUTSTANDING",
        message: `There is an outstanding debt of CLP ${amount.toLocaleString("es-CL")} in ${label}. It should be settled at closing.`,
        evidence: ev([d]),
      });
    else
      add({
        severity: "info",
        rule: "NO_DEBT",
        message: `No outstanding ${label}.`,
        evidence: ev([d]),
      });
  }

  // 6. Freshness of each certificate.
  for (const d of docs.filter((x) => x.type_confirmed)) {
    const f = d.fields.find((x) => x.key === "fecha_emision" && x.verified);
    const when = f ? parseDate(f.value) : null;
    if (!f || !when) continue;
    const age = Math.floor((now.getTime() - when.getTime()) / 86_400_000);
    if (age > STALE_AFTER_DAYS)
      add({
        severity: "warning",
        rule: "CERTIFICATE_STALE",
        message: `${d.doc_type} was issued ${age} days ago; certificates for a sale are normally required within ${STALE_AFTER_DAYS} days (a heuristic: check with the notary).`,
        evidence: ev([{ doc_type: d.doc_type, key: f.key, page: f.page, quote: f.quote }]),
      });
  }
  return out;
}

export type ReviewStatus = "blocked" | "needs_attention" | "clear" | "incomplete";

export function statusOf(findings: Finding[], docs: VerifiedDoc[]): ReviewStatus {
  if (findings.some((f) => f.severity === "blocker")) return "blocked";
  if (
    findings.some((f) => f.rule === "DOC_MISSING") ||
    new Set(docs.filter((d) => d.type_confirmed).map((d) => d.doc_type)).size < REQUIRED_DOCS.length
  )
    return "incomplete";
  if (findings.some((f) => f.severity === "warning")) return "needs_attention";
  return "clear";
}
