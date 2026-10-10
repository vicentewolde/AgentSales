import { AppError } from "@agentsales/core";

/**
 * Errores del navegador de Marketplace (spec F5 §4.4 y §4.10). Ninguno es reintentable: ante una
 * pantalla rara el robot nunca insiste, y el operador reintenta (D12). Los mensajes son propios, en
 * español, sin textos de Facebook, rutas del disco ni datos de la cuenta.
 */
export const MARKETPLACE_ERRORS = {
  /** La página pide iniciar sesión: la cuenta pasa a `expired` y se reconecta. */
  sessionExpired: () =>
    new AppError(
      "MARKETPLACE_SESSION_EXPIRED",
      "Facebook pide iniciar sesión: reconecta la cuenta (accounts connect marketplace)",
    ),
  /** Un checkpoint, una verificación de dos pasos, un captcha o un aviso de actividad inusual. */
  verificationRequired: () =>
    new AppError(
      "MARKETPLACE_VERIFICATION_REQUIRED",
      "Facebook pide una verificación: resuélvela tú en la ventana de conectar la cuenta (accounts connect marketplace); el sistema no la toca",
    ),
  /** Marketplace no está disponible o está limitado para la cuenta. */
  unavailable: () =>
    new AppError(
      "MARKETPLACE_UNAVAILABLE",
      "Marketplace no está disponible para esta cuenta: revisa en Facebook el estado de tu perfil",
    ),
  /** La página no es la esperada, o un control no apareció a tiempo: Facebook cambió algo. */
  formChanged: (detail: string) =>
    new AppError("MARKETPLACE_FORM_CHANGED", `El formulario de Marketplace cambió: ${detail}`),
  /** Otro proceso (o ventana) tiene abierto el perfil del corredor. */
  profileBusy: () =>
    new AppError(
      "MARKETPLACE_PROFILE_BUSY",
      "El perfil de Facebook del corredor está abierto en otra ventana: ciérrala y vuelve a intentar",
    ),
  /** Chromium no está instalado o no abrió. */
  browserFailed: (installed: boolean) =>
    new AppError(
      installed ? "MARKETPLACE_BROWSER_FAILED" : "MARKETPLACE_BROWSER_NOT_INSTALLED",
      installed
        ? "No se pudo abrir Chromium para Marketplace"
        : "No se encontró Chromium: pnpm --filter @agentsales/media exec playwright install chromium",
    ),
} as const;

/** La primera línea de un error de Playwright, sin rutas (pueden traer el usuario del sistema). */
export const withoutPaths = (error: unknown) =>
  (error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)).replace(
    /(?:[A-Za-z]:)?[/\\][^\s'"]+/g,
    "<ruta>",
  );
