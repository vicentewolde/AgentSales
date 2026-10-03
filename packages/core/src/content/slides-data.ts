import type { Broker } from "../broker.js";
import type {
  CoverData,
  ReelOverlayData,
  SlideBrand,
  SlideFact,
  SlideIcon,
  SlideImageRef,
  SpecSheetData,
} from "../ports/slide-templates.js";
import { formatNumber } from "../price.js";
import type { ContentBrief } from "./brief.js";

/**
 * Las filas de la ficha, en este orden: una **lista fija** de campos de la plantilla con su ícono
 * (spec F2-T10). No se recorre el brief entero: un campo propio del corredor no llega a la imagen,
 * y la dirección nunca, aunque `show_exact_address = true`. Los gastos comunes van aparte.
 */
const SPEC_SHEET_FIELDS: readonly { key: string; icon: SlideIcon }[] = [
  { key: "sup_util_m2", icon: "area" },
  { key: "sup_total_m2", icon: "area" },
  { key: "sup_terreno_m2", icon: "area" },
  { key: "dormitorios", icon: "bed" },
  { key: "banos", icon: "bath" },
  { key: "estacionamientos", icon: "parking" },
  { key: "bodegas", icon: "storage" },
  { key: "piso", icon: "floor" },
  { key: "orientacion", icon: "compass" },
  { key: "amoblado", icon: "furniture" },
  { key: "acepta_mascotas", icon: "pet" },
  { key: "ano_construccion", icon: "calendar" },
  { key: "contribuciones_trimestrales_clp", icon: "money" },
];

const propertyTypeOf = (brief: ContentBrief) => brief.propertyType ?? "Propiedad";

const plural = (count: number, singular: string, many: string) =>
  `${formatNumber(count)} ${count === 1 ? singular : many}`;

/** Los datos de la portada: m² útiles, dormitorios y baños, los que existan (y no en 0). */
export function coverFacts(brief: ContentBrief): SlideFact[] {
  const facts: SlideFact[] = [];
  if (brief.usefulArea !== null) {
    facts.push({ icon: "area", text: `${formatNumber(brief.usefulArea)} m²` });
  }
  if (brief.bedrooms !== null && brief.bedrooms > 0) {
    facts.push({ icon: "bed", text: `${formatNumber(brief.bedrooms)} dorm` });
  }
  if (brief.bathrooms !== null && brief.bathrooms > 0) {
    facts.push({ icon: "bath", text: plural(brief.bathrooms, "baño", "baños") });
  }
  return facts;
}

/** La marca del corredor para las plantillas, con el logo que se le pase (o ninguno). */
export function slideBrand<Image extends SlideImageRef>(
  broker: Pick<Broker, "brandName" | "primaryColor" | "secondaryColor">,
  logo: Image | null,
): SlideBrand<Image> {
  return {
    brandName: broker.brandName,
    primaryColor: broker.primaryColor,
    secondaryColor: broker.secondaryColor,
    logo,
  };
}

/** Portada (spec F2 §4.2): sin dirección; los datos salen del brief. */
export function coverData<Image extends SlideImageRef>(
  brief: ContentBrief,
  photo: Image,
  brand: SlideBrand<Image>,
): CoverData<Image> {
  return {
    operation: brief.operation,
    propertyType: propertyTypeOf(brief),
    comuna: brief.comuna,
    price: brief.price,
    facts: coverFacts(brief),
    photo,
    brand,
  };
}

/** Ficha: las filas de `SPEC_SHEET_FIELDS` que el aviso tiene, la disponibilidad y el contacto. */
export function specSheetData<Image extends SlideImageRef>(
  brief: ContentBrief,
  contact: Pick<Broker, "whatsapp" | "instagramHandle">,
  brand: SlideBrand<Image>,
): SpecSheetData<Image> {
  const features = new Map(brief.features.map((feature) => [feature.key, feature]));
  const rows = SPEC_SHEET_FIELDS.flatMap(({ key, icon }) => {
    const feature = features.get(key);
    return feature === undefined ? [] : [{ icon, label: feature.label, value: feature.value }];
  });
  return {
    operation: brief.operation,
    propertyType: propertyTypeOf(brief),
    comuna: brief.comuna,
    price: brief.price,
    commonExpenses: brief.commonExpenses,
    rows,
    availability: brief.availability,
    contact: { whatsapp: contact.whatsapp, instagramHandle: contact.instagramHandle },
    brand,
  };
}

/** El texto de los primeros 2 s del reel. */
export function reelOverlayData(brief: ContentBrief): ReelOverlayData {
  return {
    operation: brief.operation,
    propertyType: propertyTypeOf(brief),
    comuna: brief.comuna,
    price: brief.price,
  };
}
