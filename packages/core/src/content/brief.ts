import { describeAttributes, listingFields } from "../attributes.js";
import type { Broker } from "../broker.js";
import type { Operation } from "../enums.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import { formatListingPrice, formatNumber, formatPrice } from "../price.js";

/** Una característica del aviso lista para mostrar: `Superficie útil` → `72,5 m²`. */
export type BriefFeature = { key: string; label: string; value: string };

/**
 * Lo único que ve la IA de un aviso (spec F2 §4.6, ADR-0013), y los datos con los que el código
 * arma los textos (`assembleContents`). Nunca lleva `internal_notes`, columnas desconocidas
 * (`_extra`), campos sin definición, links ni el contacto del corredor. La dirección y el número
 * de unidad solo si `show_exact_address = true`.
 */
export type ContentBrief = {
  operation: Operation | null;
  propertyType: string | null;
  region: string | null;
  comuna: string | null;
  sectorReference: string | null;
  /** Solo con `show_exact_address = true`. */
  address: string | null;
  unitNumber: string | null;
  /** `UF 5.800` o `$650.000/mes`. */
  price: string;
  /** `$120.000`. */
  commonExpenses: string | null;
  usefulArea: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parking: number | null;
  /** Los campos definidos con valor, en el orden de las definiciones (la lista de Portal). */
  features: BriefFeature[];
  highlights: string | null;
  availability: string | null;
  amenities: string[];
  /** Solo en arriendo: la IA los redacta sin los discriminatorios. */
  rentalRequirements: string | null;
  broker: { brandName: string; tone: string | null; fixedHashtags: string[] };
};

/** Columnas de la plantilla que el contenido usa por su nombre. */
const KEYS = {
  sector: "sector_referencia",
  commonExpenses: "gastos_comunes_clp",
  usefulArea: "sup_util_m2",
  bedrooms: "dormitorios",
  bathrooms: "banos",
  parking: "estacionamientos",
  availability: "disponibilidad",
  amenities: "amenities",
  rentalRequirements: "requisitos_arriendo",
} as const;

/** Campos que no van a la lista de características: tienen su propio lugar o no son del aviso. */
const NOT_FEATURES: ReadonlySet<string> = new Set([
  KEYS.sector,
  KEYS.availability,
  KEYS.amenities,
  KEYS.rentalRequirements,
  "publicar_en",
]);

const CLP_SUFFIX = /_clp$/;
const M2_SUFFIX = /_m2$/;
const UNIT_IN_LABEL = /\s*\((?:CLP|m²)\)\s*$/;

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * Arma el brief de un aviso. `definitions` es lo que devuelve `FieldDefinitionRepository.list`
 * para su categoría y corredor (se resuelven las efectivas aquí): un campo que el corredor
 * desactivó no llega a la IA. Los links (campos `url`) nunca van.
 */
export function buildContentBrief(
  listing: Listing,
  definitions: readonly FieldDefinition[],
  broker: Pick<Broker, "brandName" | "tone" | "fixedHashtags">,
): ContentBrief {
  const fields = listingFields(definitions, listing.attributes).filter(
    (field) => field.type !== "url",
  );
  const known = new Map(fields.map((field) => [field.key, listing.attributes[field.key]]));
  const number = (key: string) => {
    const value = known.get(key);
    return typeof value === "number" ? value : null;
  };
  const text = (key: string) => textOrNull(known.get(key));

  const featureFields = fields.filter((field) => !NOT_FEATURES.has(field.key));
  const features = describeAttributes(
    Object.fromEntries(featureFields.map((field) => [field.key, known.get(field.key)])),
    featureFields,
  )
    .filter((entry) => entry.value !== "—")
    .map(({ key, label, value }) => featureOf(key, label, value, known.get(key)));

  const amenities = known.get(KEYS.amenities);
  const commonExpenses = number(KEYS.commonExpenses);
  const exact = listing.showExactAddress;
  return {
    operation: listing.operation,
    propertyType: listing.propertyType,
    region: listing.region,
    comuna: listing.comuna,
    sectorReference: text(KEYS.sector),
    address: exact ? listing.address : null,
    unitNumber: exact ? listing.unitNumber : null,
    price: formatListingPrice(listing),
    commonExpenses: commonExpenses === null ? null : formatPrice(commonExpenses, "CLP"),
    usefulArea: number(KEYS.usefulArea),
    bedrooms: number(KEYS.bedrooms),
    bathrooms: number(KEYS.bathrooms),
    parking: number(KEYS.parking),
    features,
    highlights: textOrNull(listing.highlights),
    availability: text(KEYS.availability),
    amenities: Array.isArray(amenities)
      ? amenities.map(textOrNull).filter((item) => item !== null)
      : [text(KEYS.amenities)].filter((item) => item !== null),
    rentalRequirements: listing.operation === "sale" ? null : text(KEYS.rentalRequirements),
    broker: {
      brandName: broker.brandName,
      tone: broker.tone,
      fixedHashtags: [...broker.fixedHashtags],
    },
  };
}

/** Pesos con `$` y superficies con `m²`, sin la unidad entre paréntesis en la etiqueta. */
function featureOf(key: string, label: string, value: string, raw: unknown): BriefFeature {
  if (typeof raw !== "number") return { key, label, value };
  const bare = label.replace(UNIT_IN_LABEL, "");
  if (CLP_SUFFIX.test(key)) return { key, label: bare, value: formatPrice(raw, "CLP") };
  if (M2_SUFFIX.test(key)) return { key, label: bare, value: `${formatNumber(raw)} m²` };
  return { key, label, value };
}
