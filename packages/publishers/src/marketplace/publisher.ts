import {
  AppError,
  type Publisher,
  type PublishInput,
  type PublishIssue,
  type PublishValidation,
} from "@agentsales/core";

/** Largo máximo del título de Marketplace (el de Portal, `04-formato`). */
export const MARKETPLACE_MAX_TITLE = 60;
/**
 * Cuántas fotos se suben como mucho (provisional: el máximo del formulario es NO VERIFICADO, nota
 * §5; los blogs dicen 50). T09 lo fija con el formulario real.
 */
export const MARKETPLACE_MAX_PHOTOS = 20;

/**
 * Los requisitos de Marketplace que se saben sin abrir Facebook (spec F5 §4.6): pura y síncrona,
 * como las de los otros publishers. Los motivos van en español y sin datos del aviso.
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
  }
  if (input.priceClp === undefined || !Number.isInteger(input.priceClp) || input.priceClp <= 0) {
    issues.push({ code: "PRICE_MISSING", message: "Falta el precio en pesos del formulario" });
  }
  return issues;
}

/**
 * El publisher de Marketplace (spec F5 §4.3, ADR-0017). Hasta F5-T10 es un esqueleto: declara el
 * paso manual y valida, así la simulación (`withDryRun`, que nunca abre Facebook) ya recorre todo
 * el flujo; en `live`, `publish` responde `PUBLISHER_NOT_CONFIGURED` sin abrir nada (el llenado del
 * formulario llega con T09 y T10, después de `pnpm fb:smoke`).
 */
export function createMarketplacePublisher(): Publisher {
  return {
    platform: "fb_marketplace",
    formats: ["post"],
    manualConfirm: true,
    validate(input): PublishValidation {
      const issues = validateMarketplaceInput(input);
      return issues.length === 0 ? { ok: true } : { ok: false, issues };
    },
    async publish() {
      throw new AppError(
        "PUBLISHER_NOT_CONFIGURED",
        "Todavía no se puede llenar el formulario real de Marketplace: llega después de pnpm fb:smoke (F5-T10). La simulación sí funciona",
      );
    },
  };
}
