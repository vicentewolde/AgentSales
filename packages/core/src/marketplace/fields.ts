import type { Operation } from "../enums.js";
import { AppError } from "../errors.js";
import { normalizePortalName } from "../portal/catalog.js";
import type { PublishInput, PublishListing } from "../ports/publisher.js";

/**
 * La tabla de campos de Marketplace (spec F5 §4.6, F5-T09): del aviso de AgentSales al formulario
 * de "Nueva vivienda" (`/marketplace/create/rental`). Salió del árbol real que dejó
 * `pnpm fb:smoke --menus` el 2026-10-13 (cuenta del operador, Chile, interfaz en español); los
 * controles de cada campo viven en `packages/publishers/src/marketplace/selectors.ts`.
 *
 * Lo que mostró el formulario real:
 * - **Es solo de arriendo** (la dirección termina en `/rental` y los textos dicen "en alquiler"):
 *   no hay menú de operación. Un aviso en venta no va a Marketplace
 *   (`MARKETPLACE_OPERATION_UNSUPPORTED`). Si existe otro formulario de venta en Chile es NO
 *   VERIFICADO; mientras tanto, venta = sin opción.
 * - **Tipo de propiedad en alquiler**: Casa, Casa adosada, Apartamento o piso y Solo habitación.
 *   Los demás tipos del Excel no tienen opción (`MARKETPLACE_TYPE_UNSUPPORTED`).
 * - **Sin campo de título**: Facebook arma el título; solo se escribe la descripción.
 * - **La superficie se pide en pies cuadrados** (campo opcional): se convierte desde los m² del
 *   aviso, redondeada.
 */

/** Pies cuadrados por metro cuadrado: el formulario pide "Pies cuadrados de la propiedad". */
export const SQUARE_FEET_PER_SQUARE_METER = 10.7639;

/** La operación → si el formulario la admite. El formulario real es solo de arriendo. */
const SUPPORTED_OPERATIONS: Readonly<Record<Operation, boolean>> = { rent: true, sale: false };

/** El `tipo` del Excel (normalizado) → la opción "Tipo de propiedad en alquiler" (`null`: no hay). */
const PROPERTY_TYPE_OPTIONS: Readonly<Record<string, string | null>> = {
  departamento: "Apartamento o piso",
  casa: "Casa",
  oficina: null,
  "local comercial": null,
  terreno: null,
  parcela: null,
  bodega: null,
  estacionamiento: null,
};

/** Los `tipo` del Excel que conoce la tabla (normalizados), para atarla a las definiciones de campos. */
export const MARKETPLACE_PROPERTY_TYPE_KEYS: readonly string[] = Object.keys(PROPERTY_TYPE_OPTIONS);

/**
 * La operación que admite el formulario ("Alquiler"), o `null` si no (o falta la operación). No es
 * una opción que se elija: la operación la fija la dirección del formulario.
 */
export function marketplaceOperationOption(operation: Operation | null): string | null {
  return operation !== null && SUPPORTED_OPERATIONS[operation] ? "Alquiler" : null;
}

/** La opción de tipo de propiedad del formulario, o `null` si no hay (o falta el tipo). */
export function marketplacePropertyTypeOption(propertyType: string | null): string | null {
  if (propertyType === null) return null;
  const key = normalizePortalName(propertyType);
  return Object.hasOwn(PROPERTY_TYPE_OPTIONS, key) ? (PROPERTY_TYPE_OPTIONS[key] ?? null) : null;
}

/** Lo que se escribe en el formulario: cada control con su valor, ya en el texto que lleva. */
export type MarketplaceFormPlan = {
  /** La opción de tipo de propiedad ("Apartamento o piso"). */
  propertyType: string;
  /** El precio al mes en pesos, como número entero. */
  priceClp: number;
  bedrooms: number;
  bathrooms: number;
  /** Los pies cuadrados (convertidos desde los m² útiles del aviso), o `null` si no los tiene. */
  areaSquareFeet: number | null;
  /** Lo que se busca en la ubicación: la comuna y la región. */
  location: { comuna: string; region: string | null };
  /** La dirección exacta, solo con `show_exact_address = true`; si no, `null`. */
  address: string | null;
  /** La descripción aprobada de Marketplace, sin cambios. El formulario no tiene título. */
  description: string;
};

export const marketplaceTypeUnsupported = () =>
  new AppError(
    "MARKETPLACE_TYPE_UNSUPPORTED",
    "Marketplace no tiene este tipo de propiedad: publícalo a mano o descarta la publicación",
  );

export const marketplaceOperationUnsupported = () =>
  new AppError(
    "MARKETPLACE_OPERATION_UNSUPPORTED",
    "El formulario de Marketplace en Chile es solo de arriendo: publícalo a mano o descarta la publicación",
  );

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const missingData = (field: string) =>
  new AppError(
    "MARKETPLACE_NOT_READY",
    `Falta ${field} para el formulario de Marketplace: complétalo en la planilla`,
    { details: { field } },
  );

/** La dirección del aviso con su unidad, solo si se muestra (`show_exact_address`). */
function visibleAddress(listing: PublishListing): string | null {
  if (!listing.showExactAddress || listing.address === null || listing.address.trim() === "") {
    return null;
  }
  const unit = listing.unitNumber?.trim();
  return unit === undefined || unit === ""
    ? listing.address.trim()
    : `${listing.address.trim()}, ${unit}`;
}

/**
 * Del `PublishInput` de Marketplace al plan del formulario (spec F5 §4.6). Pura. Nunca inventa un
 * dato: lo que falta da `MARKETPLACE_NOT_READY` (no debería pasar: `marketplaceReadiness` lo frena
 * antes), y un tipo o una operación sin opción, su error propio.
 */
export function marketplaceFormPlan(input: PublishInput): MarketplaceFormPlan {
  const { listing } = input;
  if (listing === undefined) throw missingData("el aviso");
  if (listing.operation === null) throw missingData("la operación");
  if (marketplaceOperationOption(listing.operation) === null)
    throw marketplaceOperationUnsupported();
  if (listing.propertyType === null) throw missingData("el tipo de propiedad");
  const propertyType = marketplacePropertyTypeOption(listing.propertyType);
  if (propertyType === null) throw marketplaceTypeUnsupported();
  if (input.priceClp === undefined) throw missingData("el precio en pesos");
  const bedrooms = numberOf(listing.attributes.dormitorios);
  if (bedrooms === null) throw missingData("la cantidad de dormitorios");
  const bathrooms = numberOf(listing.attributes.banos);
  if (bathrooms === null) throw missingData("la cantidad de baños");
  const comuna = listing.comuna?.trim() ?? "";
  if (comuna === "") throw missingData("la comuna");
  const areaM2 = numberOf(listing.attributes.sup_util_m2);
  return {
    propertyType,
    priceClp: input.priceClp,
    bedrooms,
    bathrooms,
    areaSquareFeet: areaM2 === null ? null : Math.round(areaM2 * SQUARE_FEET_PER_SQUARE_METER),
    location: { comuna, region: listing.region?.trim() || null },
    address: visibleAddress(listing),
    description: input.caption,
  };
}
