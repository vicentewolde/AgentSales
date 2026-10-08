import type { Operation } from "../enums.js";
import type { PublishBrokerContact } from "../ports/publisher.js";
import { normalizePortalName } from "./catalog.js";
import type { PortalSellerContact } from "./progress.js";

/**
 * La tabla de campos de Portal Inmobiliario (spec F4 §4.5): del aviso de AgentSales a la categoría
 * y los atributos de Mercado Libre. La usan las dos revisiones: `portalReadiness` (core, sin
 * catálogo) y `buildPortalItem` (publishers, con la hoja real). Los nombres y los obligatorios son
 * los que leyó `ml:smoke` el 2026-10-08 (nota de Mercado Libre §12.1); si Mercado Libre los cambia,
 * `buildPortalItem` lo nota con la hoja real y esta tabla se pone al día.
 */

/** Los tipos de Mercado Libre que usa AgentSales (el nombre de la categoría bajo Inmuebles). */
export type PortalPropertyType =
  | "Departamentos"
  | "Casas"
  | "Oficinas"
  | "Locales"
  | "Terrenos"
  | "Parcelas"
  | "Bodegas"
  | "Estacionamientos";

/** El `tipo` del Excel (normalizado) → el tipo de Mercado Libre. */
const PROPERTY_TYPES: Readonly<Record<string, PortalPropertyType>> = {
  departamento: "Departamentos",
  casa: "Casas",
  oficina: "Oficinas",
  "local comercial": "Locales",
  terreno: "Terrenos",
  parcela: "Parcelas",
  bodega: "Bodegas",
  estacionamiento: "Estacionamientos",
};

/** La operación en el árbol de Mercado Libre (sin `Arriendo Temporal`, que AgentSales no usa). */
const OPERATION_NAMES: Readonly<Record<Operation, string>> = { sale: "Venta", rent: "Arriendo" };

/** El subtipo de los avisos de AgentSales: nunca `Proyectos`, que piden datos de un proyecto. */
export const PORTAL_USED_SUBTYPE = "Propiedades usadas";

/** Dónde el árbol tiene subtipo (nota §12.1); en lo demás, la operación ya es la hoja. */
const WITH_SUBTYPE: Readonly<Partial<Record<PortalPropertyType, readonly Operation[]>>> = {
  Departamentos: ["sale", "rent"],
  Casas: ["sale", "rent"],
  Oficinas: ["sale", "rent"],
  Parcelas: ["sale"],
};

/** El tipo de Mercado Libre de un `tipo` del Excel, o `null` si AgentSales no lo publica en Portal. */
export function portalPropertyType(propertyType: string | null): PortalPropertyType | null {
  if (propertyType === null) return null;
  const key = normalizePortalName(propertyType);
  return Object.hasOwn(PROPERTY_TYPES, key) ? (PROPERTY_TYPES[key] ?? null) : null;
}

/**
 * Los nombres del árbol, bajo Inmuebles, hasta la hoja de un tipo y una operación (lo que recibe
 * `PortalCatalog.leafCategory`): `["Departamentos", "Venta", "Propiedades usadas"]`. `null` si el
 * tipo no se publica en Portal o falta la operación.
 */
export function portalCategoryPath(
  propertyType: string | null,
  operation: Operation | null,
): string[] | null {
  const type = portalPropertyType(propertyType);
  if (type === null || operation === null) return null;
  const path = [type, OPERATION_NAMES[operation]];
  if (WITH_SUBTYPE[type]?.includes(operation)) path.push(PORTAL_USED_SUBTYPE);
  return path;
}

/**
 * Cómo se envía cada dato (nota §12.1):
 * - `number`: `value_name` con el número (dormitorios, baños, estacionamientos, bodegas, piso);
 * - `area`: `number_unit` en m² (superficies);
 * - `fee`: `number_unit` en CLP (gastos comunes);
 * - `yes_no`: un booleano del Excel → el valor `Sí` o `No` de la hoja (amoblado);
 * - `pets`: `Sí`, `No` o `A consultar` → `Sí` o `No`; "A consultar" no existe en Mercado Libre;
 * - `facing`: la orientación → el código de la hoja (`N`, `NO`, `SP`, …);
 * - `age`: el año de construcción → la antigüedad en años.
 */
export type PortalFieldKind = "number" | "area" | "fee" | "yes_no" | "pets" | "facing" | "age";

/** Dónde lo exige Mercado Libre (sin catálogo): por tipo y operación, según la nota §12.1. */
export type PortalRequirement = (type: PortalPropertyType, operation: Operation) => boolean;

export type PortalAttributeField = {
  /** La llave del campo en el Excel (`listings.attributes`). */
  field: string;
  /** Cómo lo nombra el operador (el mensaje de lo que falta). */
  label: string;
  /** El id del atributo en Mercado Libre. */
  attribute: string;
  kind: PortalFieldKind;
  required: PortalRequirement;
};

const never: PortalRequirement = () => false;
const always: PortalRequirement = () => true;
/** Todo menos terrenos y estacionamientos (superficie útil, baños, estacionamientos). */
const built: PortalRequirement = (type) => type !== "Terrenos" && type !== "Estacionamientos";
/** Departamentos, casas y parcelas (dormitorios). */
const homes: PortalRequirement = (type) =>
  type === "Departamentos" || type === "Casas" || type === "Parcelas";
/** Arriendo de departamentos y casas (amoblado, mascotas, bodegas). */
const homeRent: PortalRequirement = (type, operation) =>
  operation === "rent" && (type === "Departamentos" || type === "Casas");

/** La tabla de atributos (spec F4 §4.5). Lo que no está aquí no se envía. */
export const PORTAL_ATTRIBUTE_FIELDS: readonly PortalAttributeField[] = [
  {
    field: "dormitorios",
    label: "Dormitorios",
    attribute: "BEDROOMS",
    kind: "number",
    required: homes,
  },
  { field: "banos", label: "Baños", attribute: "FULL_BATHROOMS", kind: "number", required: built },
  {
    field: "estacionamientos",
    label: "Estacionamientos",
    attribute: "PARKING_LOTS",
    kind: "number",
    required: built,
  },
  {
    field: "bodegas",
    label: "Bodegas",
    attribute: "WAREHOUSES",
    kind: "number",
    required: homeRent,
  },
  {
    field: "sup_util_m2",
    label: "Superficie útil (m²)",
    attribute: "COVERED_AREA",
    kind: "area",
    required: built,
  },
  {
    field: "sup_total_m2",
    label: "Superficie total (m²)",
    attribute: "TOTAL_AREA",
    kind: "area",
    required: always,
  },
  {
    field: "gastos_comunes_clp",
    label: "Gastos comunes (CLP)",
    attribute: "MAINTENANCE_FEE",
    kind: "fee",
    required: (type, operation) => operation === "rent" && type === "Departamentos",
  },
  {
    field: "amoblado",
    label: "Amoblado",
    attribute: "FURNISHED",
    kind: "yes_no",
    required: homeRent,
  },
  {
    field: "acepta_mascotas",
    label: "Acepta mascotas",
    attribute: "IS_SUITABLE_FOR_PETS",
    kind: "pets",
    required: homeRent,
  },
  { field: "piso", label: "Piso", attribute: "UNIT_FLOOR", kind: "number", required: never },
  {
    field: "orientacion",
    label: "Orientación",
    attribute: "FACING",
    kind: "facing",
    required: never,
  },
  {
    field: "ano_construccion",
    label: "Año de construcción",
    attribute: "PROPERTY_AGE",
    kind: "age",
    required: never,
  },
];

/** La orientación del Excel → el código de `FACING` en Mercado Libre (nota §12.1). */
export const PORTAL_FACING_CODES: Readonly<Record<string, string>> = {
  norte: "N",
  sur: "S",
  oriente: "O",
  poniente: "P",
  nororiente: "NO",
  norponiente: "NP",
  suroriente: "SO",
  surponiente: "SP",
};

/** Lo que el Excel dice de mascotas: `Sí`/`No`, o `undecided` ("A consultar"), o `null`. */
export function portalPetsAnswer(value: unknown): "si" | "no" | "undecided" | null {
  if (typeof value !== "string") return null;
  const answer = normalizePortalName(value);
  if (answer === "si" || answer === "no") return answer;
  return answer === "a consultar" ? "undecided" : null;
}

/**
 * El WhatsApp del corredor en la forma de `seller_contact` (nota §4.2): solo dígitos, con el
 * código de país (`56`) aparte. Acepta `+56 9 1234 5678`, `56912345678` o los 9 dígitos sin el
 * código (Mercado Libre Chile). `null` si no se puede leer así: no se adivina otro país.
 */
export function portalWhatsappParts(
  whatsapp: string | null,
): { countryCode2: string; phone2: string } | null {
  if (whatsapp === null) return null;
  const digits = whatsapp.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("56") ? digits.slice(2) : digits;
  return local.length === 9 ? { countryCode2: "56", phone2: local } : null;
}

/** El `seller_contact` del corredor (spec F4 §4.5), o `null` si su WhatsApp falta o no se lee. */
export function portalSellerContact(contact: PublishBrokerContact): PortalSellerContact | null {
  const parts = portalWhatsappParts(contact.whatsapp);
  if (parts === null) return null;
  return {
    contact: contact.name.trim() === "" ? null : contact.name.trim(),
    email: contact.email === null || contact.email.trim() === "" ? null : contact.email.trim(),
    ...parts,
  };
}
