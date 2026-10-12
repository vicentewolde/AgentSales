import type { Operation } from "../enums.js";
import { AppError } from "../errors.js";
import { normalizePortalName } from "../portal/catalog.js";
import type { PublishInput, PublishListing } from "../ports/publisher.js";

/**
 * La tabla de campos de Marketplace (spec F5 §4.6, F5-T09): del aviso de AgentSales a las opciones
 * del formulario de "Propiedad en venta o alquiler". Los textos de las opciones son los que muestra
 * el formulario en español de Chile; los selectores de cada control viven en
 * `packages/publishers/src/marketplace/selectors.ts`.
 *
 * **POR CONFIRMAR** con los árboles de `pnpm fb:smoke --menus` (spec F5 §4.8): hasta entonces las
 * opciones son las probables (nota `fb-marketplace.md` §4.1, pistas de blogs) y el PR del lote E
 * no se mezcla. Un tipo o una operación sin opción (`null`) no va a Marketplace: lo dice
 * `marketplaceReadiness` y, si llegara al intento, `MARKETPLACE_TYPE_UNSUPPORTED` u
 * `MARKETPLACE_OPERATION_UNSUPPORTED` (no reintentables).
 */

/** La operación → la opción del formulario (`null`: Chile no la tiene en Marketplace). */
const OPERATION_OPTIONS: Readonly<Record<Operation, string | null>> = {
  rent: "Alquiler",
  sale: "Venta",
};

/** El `tipo` del Excel (normalizado) → la opción "Tipo de propiedad" (`null`: no hay opción). */
const PROPERTY_TYPE_OPTIONS: Readonly<Record<string, string | null>> = {
  departamento: "Departamento",
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

/** La opción de operación del formulario, o `null` si no hay (o falta la operación). */
export function marketplaceOperationOption(operation: Operation | null): string | null {
  return operation === null ? null : OPERATION_OPTIONS[operation];
}

/** La opción de tipo de propiedad del formulario, o `null` si no hay (o falta el tipo). */
export function marketplacePropertyTypeOption(propertyType: string | null): string | null {
  if (propertyType === null) return null;
  const key = normalizePortalName(propertyType);
  return Object.hasOwn(PROPERTY_TYPE_OPTIONS, key) ? (PROPERTY_TYPE_OPTIONS[key] ?? null) : null;
}

/** Lo que se escribe en el formulario: cada control con su valor, ya en el texto que lleva. */
export type MarketplaceFormPlan = {
  /** La opción de operación ("Alquiler"). */
  operation: string;
  /** La opción de tipo de propiedad ("Departamento"). */
  propertyType: string;
  /** El precio en pesos, como número entero (en arriendo, por mes). */
  priceClp: number;
  bedrooms: number;
  bathrooms: number;
  /** Los m² útiles, si el aviso los tiene. */
  areaM2: number | null;
  /** Lo que se busca en la ubicación: la comuna y la región. */
  location: { comuna: string; region: string | null };
  /** La dirección exacta, solo con `show_exact_address = true`; si no, `null`. */
  address: string | null;
  /** El título y la descripción aprobados de Marketplace, sin cambios. */
  title: string;
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
    "Marketplace en Chile no tiene esta operación: publícalo a mano o descarta la publicación",
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
  const operation = marketplaceOperationOption(listing.operation);
  if (listing.operation === null) throw missingData("la operación");
  if (operation === null) throw marketplaceOperationUnsupported();
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
  return {
    operation,
    propertyType,
    priceClp: input.priceClp,
    bedrooms,
    bathrooms,
    areaM2: numberOf(listing.attributes.sup_util_m2),
    location: { comuna, region: listing.region?.trim() || null },
    address: visibleAddress(listing),
    title: input.title?.trim() ?? "",
    description: input.caption,
  };
}
