import type { PublishBrokerContact, PublishIssue, PublishListing } from "../ports/publisher.js";
import {
  PORTAL_ATTRIBUTE_FIELDS,
  PORTAL_ISSUE_MESSAGES,
  portalFieldHasValue,
  portalPetsAnswer,
  portalPrice,
  portalPropertyType,
  portalWhatsappParts,
} from "./fields.js";

/** Lo que falta para Portal, con el campo del Excel que hay que completar (`null`: no es del aviso). */
export type PortalReadinessIssue = PublishIssue & { field: string | null };

export type PortalReadiness = { ready: true } | { ready: false; issues: PortalReadinessIssue[] };

/** Lo del aviso que mira la revisión: lo mismo que va en el `PublishInput` de Portal. */
export type PortalReadinessListing = Pick<
  PublishListing,
  | "operation"
  | "propertyType"
  | "region"
  | "comuna"
  | "address"
  | "showExactAddress"
  | "priceAmount"
  | "priceCurrency"
  | "attributes"
>;

const missing = (field: string, label: string): PortalReadinessIssue => ({
  code: "PORTAL_FIELD_MISSING",
  field,
  message: `Falta ${label}: complétalo en la planilla`,
});

/**
 * ¿Está el aviso listo para Portal Inmobiliario? (spec F4 §4.5): lo que AgentSales sabe que pide
 * Mercado Libre, sin catálogo ni red, con la tabla de `portal/fields.ts`. La usan aprobar (como
 * advertencia), la vista del contenido (la pestaña Portal) y publicar (`PORTAL_NOT_READY`, T16).
 * Nunca inventa un dato: si Mercado Libre lo exige y falta, lo pide (D8). Lo que solo sabe la hoja
 * real (un obligatorio nuevo, el largo del título, la moneda) lo revisa `buildPortalItem`.
 */
export function portalReadiness(
  listing: PortalReadinessListing,
  broker: PublishBrokerContact,
): PortalReadiness {
  const issues: PortalReadinessIssue[] = [];
  const type = portalPropertyType(listing.propertyType);
  if (listing.operation === null)
    issues.push(missing("operacion", "la operación (Venta o Arriendo)"));
  if (listing.propertyType === null) {
    issues.push(missing("tipo", "el tipo de propiedad"));
  } else if (type === null) {
    issues.push({
      code: "PORTAL_TYPE_UNSUPPORTED",
      field: "tipo",
      message:
        "AgentSales no publica este tipo de propiedad en Portal Inmobiliario (Departamento, Casa, Oficina, Local comercial, Terreno, Parcela, Bodega o Estacionamiento)",
    });
  }
  if (listing.region === null) issues.push(missing("region", "la región"));
  if (listing.comuna === null) issues.push(missing("comuna", "la comuna"));
  if (listing.showExactAddress && listing.address === null) {
    issues.push(missing("direccion", "la dirección (se muestra en el aviso)"));
  }
  if (portalPrice(listing.priceAmount, listing.priceCurrency) === null) {
    issues.push({
      code: "PORTAL_PRICE_INVALID",
      field: "precio",
      message: "El precio tiene que ser mayor que 0 (y sin decimales si está en pesos)",
    });
  }

  if (type !== null && listing.operation !== null) {
    const operation = listing.operation;
    for (const entry of PORTAL_ATTRIBUTE_FIELDS) {
      if (!entry.required(type, operation)) continue;
      const value = listing.attributes[entry.field];
      if (entry.kind === "pets" && portalPetsAnswer(value) === "undecided") {
        issues.push({
          code: "PORTAL_PETS_UNDECIDED",
          field: entry.field,
          message: PORTAL_ISSUE_MESSAGES.petsUndecided,
        });
      } else if (!portalFieldHasValue(entry.kind, value)) {
        issues.push(missing(entry.field, entry.label));
      }
    }
  }

  if (broker.whatsapp === null || broker.whatsapp.trim() === "") {
    issues.push({
      code: "PORTAL_WHATSAPP_MISSING",
      field: null,
      message: PORTAL_ISSUE_MESSAGES.whatsappMissing,
    });
  } else if (portalWhatsappParts(broker.whatsapp) === null) {
    issues.push({
      code: "PORTAL_WHATSAPP_INVALID",
      field: null,
      message: PORTAL_ISSUE_MESSAGES.whatsappInvalid,
    });
  }
  return issues.length === 0 ? { ready: true } : { ready: false, issues };
}
