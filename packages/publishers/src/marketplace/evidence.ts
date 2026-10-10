import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { pathOf } from "./guard.js";
import { FORM_ROOT } from "./selectors.js";

/** Lo que quedó guardado de una página: los archivos, por nombre. */
export type MarketplaceEvidence = {
  /** Captura PNG del formulario. */
  screenshot: string;
  /** Árbol de accesibilidad del formulario (YAML de Playwright). */
  aria: string;
};

/**
 * Guarda la evidencia **del formulario** (spec F5 §4.4, paso 6, y §4.8): su captura y su árbol de
 * accesibilidad, en `dir` (carpeta `0700`), con el prefijo `name`. Nunca la página entera: la barra
 * de Facebook muestra el nombre, la foto y los mensajes del operador. Se usa solo con la página ya
 * reconocida como formulario (`requireForm`); en una pantalla de inicio de sesión o verificación no
 * se captura nada (ver `stopRecord`).
 */
export async function captureFormEvidence(
  page: Page,
  dir: string,
  name: string,
): Promise<MarketplaceEvidence> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const form = page.locator(FORM_ROOT).first();
  const screenshot = join(dir, `${name}.png`);
  const aria = join(dir, `${name}.aria.yml`);
  await form.screenshot({ path: screenshot, animations: "disabled", timeout: 10_000 });
  await writeFile(aria, `${await form.ariaSnapshot({ timeout: 10_000 })}\n`, { mode: 0o600 });
  return { screenshot, aria };
}

/**
 * Lo que se anota de una página donde el sistema se detuvo: solo la ruta, sin consulta ni
 * fragmento (pueden traer datos) y sin captura (puede mostrar el correo o el teléfono).
 */
export const stopRecord = (page: Page) => ({ path: pathOf(page.url()) });
