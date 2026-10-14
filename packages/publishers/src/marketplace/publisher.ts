import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  marketplaceFormPlan,
  marketplaceOperationOption,
  marketplacePropertyTypeOption,
  type Publisher,
  type PublishInput,
  type PublishIssue,
  type PublishMediaItem,
  type PublishValidation,
} from "@agentsales/core";
import { MARKETPLACE_ERRORS } from "./errors.js";
import { captureFormEvidence } from "./evidence.js";
import { type FillMarketplaceOptions, fillMarketplaceForm } from "./fill.js";
import { requireForm } from "./guard.js";
import {
  MARKETPLACE_PROFILE_BUSY_WAIT_MS,
  type MarketplaceProfile,
  openProfileWhenFree,
} from "./profile.js";
import { FORM_WAIT_MS, MARKETPLACE_FORM_URL } from "./selectors.js";
import { createMarketplaceWindow, type MarketplaceWindow } from "./window.js";

/** Largo máximo del título de Marketplace (el de Portal, `04-formato`). */
export const MARKETPLACE_MAX_TITLE = 60;
/** Cuántas fotos admite el formulario: «Fotos 0/50» (`fb:smoke --menus`, 2026-10-13). */
export const MARKETPLACE_MAX_PHOTOS = 50;

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

/** La ventana que se entrega al worker, con lo que la identifica. */
export type MarketplaceHandoffRef = { publicationId: string; brokerId: string; accountId: string };

export type MarketplacePublisherDeps = {
  /** Abre el perfil del corredor (`openMarketplaceProfile`, con ventana; los tests, sin ella). */
  openProfile(brokerId: string): Promise<MarketplaceProfile>;
  /** Los bytes de una foto fijada (`pi_4x3`, JPEG), leídos de R2. */
  readPhoto(media: PublishMediaItem): Promise<Uint8Array>;
  /** `<workspace>/tmp/marketplace`: las fotos (se borran al terminar) y la evidencia. */
  tmpRoot: string;
  /**
   * Cierra la ventana de un intento anterior de la misma cuenta (el registro del worker), antes de
   * abrir el perfil: un perfil, una ventana (spec F5 §4.4, paso 2).
   */
  closeAccountWindows(accountId: string): Promise<void>;
  /** Entrega la ventana con el formulario listo (el registro la deja pendiente; spec F5 §4.3). */
  onHandoff(ref: MarketplaceHandoffRef, window: MarketplaceWindow): Promise<void>;
  /** El ritmo y los topes del llenado (los tests: pausa 0 y topes cortos). */
  fill?: Omit<FillMarketplaceOptions, "evidenceDir">;
  /** Cuánto espera la lista blanca al formulario. */
  formWaitMs?: number;
  /** Cuánto espera a que se libere un perfil tomado (`MARKETPLACE_PROFILE_BUSY`). */
  profileBusyWaitMs?: number;
  /** El tope del intento (por defecto, `MARKETPLACE_PUBLISH_MAX_MS`). */
  maxMs?: number;
};

/** Tope de un intento (spec F5 §4.4): la cola no espera el clic del operador. */
export const MARKETPLACE_PUBLISH_MAX_MS = 5 * 60_000;

/** La carpeta de un intento: fotos (temporales) y evidencia. */
export const marketplaceAttemptDir = (tmpRoot: string, publicationId: string) =>
  join(tmpRoot, publicationId);

/**
 * El publisher de Marketplace (spec F5 §4.3 y §4.4, ADR-0017; F5-T10). `publish` (solo en `live`:
 * en `dry-run` lo envuelve `withDryRun`, que nunca abre el navegador):
 * 1. Baja de R2 las fotos fijadas a `tmp/marketplace/<publicationId>/` (`0700`).
 * 2. Cierra la ventana vieja de la cuenta y abre el perfil del corredor (si sigue tomado, reintenta
 *    hasta `profileBusyWaitMs`; después, `MARKETPLACE_PROFILE_BUSY`). Va al formulario.
 * 3. Lista blanca (`requireForm`), y antes de cada paso del llenado.
 * 4. Llena el formulario y sube las fotos (`fillMarketplaceForm`).
 * 5. Guarda la evidencia **del formulario** y entrega la ventana con `onHandoff`. Devuelve `handoff`.
 * Ante **cualquier** error (los `MARKETPLACE_*`, R2, la entrega) cierra la ventana y suelta el
 * perfil antes de lanzar. Las fotos se borran siempre; la evidencia queda (la limpia el worker a
 * los 7 días). **Nunca** hace clic en Siguiente ni Publicar.
 */
export function createMarketplacePublisher(deps: MarketplacePublisherDeps): Publisher {
  const validate = (input: PublishInput): PublishValidation => {
    const issues = validateMarketplaceInput(input);
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  };
  return {
    platform: "fb_marketplace",
    formats: ["post"],
    manualConfirm: true,
    validate,
    async publish(input, ctx) {
      const checked = validate(input);
      if (!checked.ok) {
        throw new AppError("PUBLISH_INPUT_INVALID", "El aviso no está listo para Marketplace", {
          details: { issues: checked.issues },
        });
      }
      // Antes de bajar nada: un tipo o una operación sin opción no abre el navegador.
      const plan = marketplaceFormPlan(input);
      const dir = marketplaceAttemptDir(deps.tmpRoot, input.publicationId);
      const photosDir = join(dir, "fotos");
      await mkdir(photosDir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      let profile: MarketplaceProfile | undefined;
      // El tope o el apagado del worker cierran la ventana: lo que estaba en curso falla y se sale.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void profile?.close();
      }, deps.maxMs ?? MARKETPLACE_PUBLISH_MAX_MS);
      const onAbort = () => void profile?.close();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const photoPaths: string[] = [];
        for (const [index, media] of input.media.entries()) {
          const path = join(photosDir, `foto-${String(index + 1).padStart(2, "0")}.jpg`);
          await writeFile(path, await deps.readPhoto(media), { mode: 0o600 });
          photoPaths.push(path);
        }
        const cut = () => timedOut || ctx.signal?.aborted === true;
        if (cut()) throw MARKETPLACE_ERRORS.formChanged("se cortó el llenado");
        await deps.closeAccountWindows(ctx.account.id);
        profile = await openProfileWhenFree(() => deps.openProfile(ctx.account.brokerId), {
          waitMs: deps.profileBusyWaitMs ?? MARKETPLACE_PROFILE_BUSY_WAIT_MS,
          cut,
        });
        if (cut()) throw MARKETPLACE_ERRORS.formChanged("se cortó el llenado");
        const { page } = profile;
        await page.goto(MARKETPLACE_FORM_URL);
        await requireForm(page, { timeoutMs: deps.formWaitMs ?? FORM_WAIT_MS });
        await fillMarketplaceForm(page, plan, photoPaths, { ...deps.fill, evidenceDir: dir });
        await captureFormEvidence(page, dir, "formulario");
        const window = createMarketplaceWindow(profile);
        await deps.onHandoff(
          {
            publicationId: input.publicationId,
            brokerId: ctx.account.brokerId,
            accountId: ctx.account.id,
          },
          window,
        );
        // Si el tope venció mientras se entregaba, la ventana ya se cerró: no se da por listo.
        if (cut()) throw MARKETPLACE_ERRORS.formChanged("se cortó el llenado");
        return { handoff: "manual_confirm", simulated: false };
      } catch (error) {
        await profile?.close();
        // Un corte deja errores de Playwright sin sentido ("Target closed"): se dice qué pasó.
        if (ctx.signal?.aborted) throw MARKETPLACE_ERRORS.formChanged("se cortó el llenado");
        if (timedOut) throw MARKETPLACE_ERRORS.formChanged("el llenado pasó su tope de tiempo");
        throw error;
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        await rm(photosDir, { recursive: true, force: true });
      }
    },
  };
}
