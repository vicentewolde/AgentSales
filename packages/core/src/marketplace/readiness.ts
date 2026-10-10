import type { PublishIssue, PublishListing } from "../ports/publisher.js";

/** Lo que falta para Marketplace, con el campo de la planilla que hay que completar (`null`: no es del aviso). */
export type MarketplaceReadinessIssue = PublishIssue & { field: string | null };

export type MarketplaceReadiness =
  | { ready: true }
  | { ready: false; issues: MarketplaceReadinessIssue[] };

/** Lo del aviso que mira la revisión: lo mismo que va en el `PublishInput` de Marketplace. */
export type MarketplaceReadinessListing = Pick<
  PublishListing,
  | "operation"
  | "propertyType"
  | "region"
  | "comuna"
  | "priceAmount"
  | "priceCurrency"
  | "attributes"
>;

const missing = (field: string, label: string): MarketplaceReadinessIssue => ({
  code: "MARKETPLACE_FIELD_MISSING",
  field,
  message: `Falta ${label}: complétalo en la planilla`,
});

/** Un número de la planilla con valor (0 vale: un monoambiente tiene 0 dormitorios). */
const hasNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

/**
 * ¿Está el aviso listo para Marketplace? (spec F5 §4.6, F5-T07): lo que el formulario pide y no
 * depende de sus opciones exactas (eso lo suma T09 con el árbol de `fb:smoke`). Pura, sin red. La
 * usan aprobar (como advertencia), la vista del contenido y las dos rutas de publicar
 * (`MARKETPLACE_NOT_READY`). Nunca inventa un dato: si falta, lo pide.
 * - `photos`: cuántas fotos 4:3 tiene el aviso (las mismas de Portal).
 * - `ufConfigured`: si hay token del Banco Central (`BCCH_API_TOKEN`): sin él, un precio en UF no
 *   se puede convertir (`UF_SOURCE_NOT_CONFIGURED`).
 */
export function marketplaceReadiness(
  listing: MarketplaceReadinessListing,
  { photos, ufConfigured }: { photos: number; ufConfigured: boolean },
): MarketplaceReadiness {
  const issues: MarketplaceReadinessIssue[] = [];
  if (photos < 1) {
    issues.push({
      code: "MARKETPLACE_PHOTOS_MISSING",
      field: null,
      message: "Marketplace pide al menos una foto: prepara el contenido del aviso",
    });
  }
  if (listing.operation === null) {
    issues.push(missing("operacion", "la operación (Venta o Arriendo)"));
  }
  if (listing.propertyType === null) issues.push(missing("tipo", "el tipo de propiedad"));
  if (!(listing.priceAmount > 0)) issues.push(missing("precio", "el precio"));
  if (listing.priceCurrency === "UF" && !ufConfigured) {
    issues.push({
      code: "UF_SOURCE_NOT_CONFIGURED",
      field: null,
      message:
        "El precio está en UF y Marketplace lo pide en pesos: falta BCCH_API_TOKEN en .env para convertirlo con el valor del día",
    });
  }
  if (!hasNumber(listing.attributes.dormitorios)) {
    issues.push(missing("dormitorios", "la cantidad de dormitorios"));
  }
  if (!hasNumber(listing.attributes.banos)) issues.push(missing("banos", "la cantidad de baños"));
  if (listing.comuna === null || listing.comuna.trim() === "") {
    issues.push(missing("comuna", "la comuna"));
  }
  return issues.length === 0 ? { ready: true } : { ready: false, issues };
}
