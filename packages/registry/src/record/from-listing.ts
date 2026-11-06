import { type Claim, type Declared, DEFAULT_POLICY, type Policy } from "../claims/schema.js";
import { declaredClaims } from "../claims/verify.js";
import { canonicalJson, sha256 } from "../passport/merkle.js";

/**
 * Lo que el registro necesita de una propiedad de AgentSales. Es estructural: coincide con el
 * `Listing` de core sin depender de él (el registro no conoce la base).
 */
export type ListingSource = {
  id: string;
  brokerId: string;
  operation: "sale" | "rent" | null;
  propertyType: string | null;
  comuna: string | null;
  address: string | null;
  showExactAddress: boolean;
  priceAmount: number;
  priceCurrency: "UF" | "CLP";
  attributes: Record<string, unknown>;
  updatedAt: Date;
};

export type RegistryPayload = { declared: Declared; policy: Policy; claims: Claim[] };

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};

function amenitiesOf(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .slice(0, 30);
}

/** Lo declarado por el corredor, la política por defecto y una afirmación `broker_declared` por dato. */
export function buildPayload(src: ListingSource): RegistryPayload {
  const a = src.attributes;
  const comuna = src.comuna ?? "Chile";
  const pets = typeof a.acepta_mascotas === "boolean" ? a.acepta_mascotas : null;
  const declared: Declared = {
    title: `${src.propertyType ?? "Propiedad"} en ${comuna}`,
    operation: src.operation ?? "sale",
    commune: comuna,
    address: src.address,
    price: { amount: src.priceAmount, currency: src.priceCurrency },
    area_m2: num(a.sup_util_m2) ?? num(a.sup_total_m2),
    bedrooms: int(a.dormitorios),
    bathrooms: int(a.banos),
    pets_allowed: pets,
  };
  const at = src.updatedAt.toISOString();
  const claims = declaredClaims(declared, src.brokerId, at);
  amenitiesOf(a.amenities).forEach((name, i) => {
    claims.push({
      id: `d-amenity-${i + 1}`,
      category: "feature",
      statement: name,
      provenance: "broker_declared",
      evidence: {
        kind: "declared",
        frame: null,
        t_sec: null,
        box: null,
        confidence: null,
        concept: `declared by ${src.brokerId} at ${at}`,
        frames_detected: 0,
        image: null,
      },
      note: null,
    });
  });
  const policy: Policy = { ...DEFAULT_POLICY, showExactAddress: src.showExactAddress };
  return { declared, policy, claims };
}

/** sha256 del contenido canónico: cambia si y solo si cambia algo que el corredor declaró. */
export function payloadHash(payload: RegistryPayload): string {
  return sha256(canonicalJson(payload));
}
