import type { AppError } from "@agentsales/core";
import type { Page } from "playwright";
import { MARKETPLACE_ERRORS } from "./errors.js";
import {
  CAPTCHA_FRAME,
  FORM_ROOT,
  FORM_WAIT_MS,
  LOGIN_PATHS,
  MARKETPLACE_CREATE_PATH,
  PASSWORD_INPUT,
  UNAVAILABLE_TEXTS,
  VERIFICATION_PATHS,
  VERIFICATION_TEXTS,
} from "./selectors.js";

/** Lo que es la página a la vista, según la lista blanca (spec F5 §4.4, paso 3). */
export type MarketplacePageKind =
  | "form"
  | "login"
  | "verification"
  | "unavailable"
  /** Todavía no se sabe (la página carga) o no es nada conocido. */
  | "unknown";

/** Minúsculas y sin tildes, para comparar textos en cualquier forma. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[’`]/g, "'");

/** La ruta de una dirección, sin consulta ni fragmento (la consulta puede traer datos). */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * Clasifica la página **solo para decidir si detenerse** (D5): mira la ruta, si hay un campo de
 * contraseña o un captcha, y el texto visible contra listas fijas. No guarda nada de lo leído.
 * El orden importa: una verificación gana a todo (aunque la página traiga el formulario detrás).
 */
export async function classifyPage(page: Page): Promise<MarketplacePageKind> {
  const path = pathOf(page.url());
  if (VERIFICATION_PATHS.some((pattern) => pattern.test(path))) return "verification";
  if (LOGIN_PATHS.some((pattern) => pattern.test(path))) return "login";
  if ((await page.locator(CAPTCHA_FRAME).count()) > 0) return "verification";
  const text = plain(
    await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => ""),
  );
  if (VERIFICATION_TEXTS.some((phrase) => text.includes(phrase))) return "verification";
  if (UNAVAILABLE_TEXTS.some((phrase) => text.includes(phrase))) return "unavailable";
  if ((await page.locator(PASSWORD_INPUT).count()) > 0) return "login";
  if (MARKETPLACE_CREATE_PATH.test(path) && (await page.locator(FORM_ROOT).count()) > 0) {
    return "form";
  }
  return "unknown";
}

/** El error de detenerse ante cada pantalla que no es el formulario. */
export function stopErrorOf(kind: Exclude<MarketplacePageKind, "form">): AppError {
  switch (kind) {
    case "login":
      return MARKETPLACE_ERRORS.sessionExpired();
    case "verification":
      return MARKETPLACE_ERRORS.verificationRequired();
    case "unavailable":
      return MARKETPLACE_ERRORS.unavailable();
    case "unknown":
      return MARKETPLACE_ERRORS.formChanged("la página no es el formulario de propiedades");
  }
}

export type RequireFormOptions = {
  /** Cuánto espera a que aparezca el formulario (por defecto, `FORM_WAIT_MS`). */
  timeoutMs?: number;
  /** Cada cuánto vuelve a mirar. */
  pollMs?: number;
};

/**
 * **Lista blanca** (spec F5 §4.4, paso 3): espera a que la página sea el formulario de crear un
 * aviso. Ante un inicio de sesión, una verificación, un captcha o Marketplace no disponible, se
 * detiene de inmediato con su error; si en el tope sigue sin ser el formulario,
 * `MARKETPLACE_FORM_CHANGED`. Nunca hace clic ni escribe nada.
 */
export async function requireForm(page: Page, options: RequireFormOptions = {}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? FORM_WAIT_MS);
  const pollMs = options.pollMs ?? 250;
  for (;;) {
    const kind = await classifyPage(page);
    if (kind === "form") return;
    if (kind !== "unknown" || Date.now() >= deadline) throw stopErrorOf(kind);
    await page.waitForTimeout(pollMs);
  }
}
