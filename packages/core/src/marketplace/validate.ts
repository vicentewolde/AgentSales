import type { PublishInput, PublishIssue } from "../ports/publisher.js";
import { marketplaceOperationOption, marketplacePropertyTypeOption } from "./fields.js";

/** Largo máximo del título de Marketplace (el de Portal, `04-formato`). */
export const MARKETPLACE_MAX_TITLE = 60;
/** Cuántas fotos admite el formulario: «Fotos 0/50» (`fb:smoke --menus`, 2026-10-13). */
export const MARKETPLACE_MAX_PHOTOS = 50;

/**
 * Los requisitos de Marketplace que se saben sin abrir Facebook (spec F5 §4.6): pura y síncrona.
 * Los usan el publisher del formulario (`validate`) y, desde F7-T15, el traspaso a mano (ADR-0023:
 * el corredor no debería copiar algo que Facebook rechazará). Los motivos van en español y sin
 * datos del aviso.
 */
export function validateMarketplaceInput(input: PublishInput): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const title = input.title?.trim() ?? "";
  if (title.length === 0) {
    issues.push({ code: "TITLE_MISSING", message: "Falta el título de Marketplace" });
  } else if (title.length > MARKETPLACE_MAX_TITLE) {
    issues.push({
      code: "TITLE_TOO_LONG",
      message: `El título de Marketplace tiene más de ${MARKETPLACE_MAX_TITLE} caracteres`,
    });
  }
  const photos = input.media.filter((item) => item.kind === "image");
  if (photos.length === 0 || photos.length !== input.media.length) {
    issues.push({ code: "PHOTOS_INVALID", message: "Marketplace lleva solo fotos, al menos una" });
  } else if (photos.length > MARKETPLACE_MAX_PHOTOS) {
    issues.push({
      code: "TOO_MANY_PHOTOS",
      message: `Marketplace lleva hasta ${MARKETPLACE_MAX_PHOTOS} fotos`,
    });
  }
  if (photos.some((item) => item.mime !== "image/jpeg")) {
    issues.push({ code: "PHOTO_NOT_JPEG", message: "Las fotos de Marketplace van en JPEG" });
  }
  if (input.listing === undefined) {
    issues.push({ code: "LISTING_MISSING", message: "Falta el aviso en lo que se publica" });
  } else {
    // Lo que el formulario real no admite (solo arriendo; cuatro tipos): se rechaza igual en la
    // simulación que en vivo, antes de abrir nada.
    if (marketplaceOperationOption(input.listing.operation) === null) {
      issues.push({
        code: "MARKETPLACE_OPERATION_UNSUPPORTED",
        message: "El formulario de Marketplace en Chile es solo de arriendo",
      });
    }
    if (marketplacePropertyTypeOption(input.listing.propertyType) === null) {
      issues.push({
        code: "MARKETPLACE_TYPE_UNSUPPORTED",
        message: "Marketplace no admite este tipo de propiedad",
      });
    }
  }
  if (input.priceClp === undefined || !Number.isInteger(input.priceClp) || input.priceClp <= 0) {
    issues.push({ code: "PRICE_MISSING", message: "Falta el precio en pesos del formulario" });
  }
  return issues;
}
