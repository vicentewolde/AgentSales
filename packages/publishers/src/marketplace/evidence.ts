import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { pathOf } from "./guard.js";
import { FORM_CONTAINER, FORM_ELEMENT, OPEN_LIST, OPEN_LIST_EXCLUDED } from "./selectors.js";

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
  const form = await formLocator(page);
  const screenshot = join(dir, `${name}.png`);
  const aria = join(dir, `${name}.aria.yml`);
  await form.screenshot({ path: screenshot, animations: "disabled", timeout: 10_000 });
  await writeFile(aria, `${await form.ariaSnapshot({ timeout: 10_000 })}\n`, { mode: 0o600 });
  return { screenshot, aria };
}

/** El formulario: primero el `form` (lo más acotado) y, solo si no hay, el contenedor principal. */
async function formLocator(page: Page) {
  const element = page.locator(FORM_ELEMENT);
  return ((await element.count()) > 0 ? element : page.locator(FORM_CONTAINER)).first();
}

/** Lo que guardó `captureOpenLists`: el archivo y cuántas listas desplegadas vio. */
export type MarketplaceListsEvidence = { aria: string; lists: number };

/**
 * Guarda en `<name>.aria.yml` el árbol del formulario y el de cada lista desplegada a la vista
 * (`fb:smoke --menus`, spec F5 §4.8): las opciones de un menú cerrado no salen en el árbol, así que
 * el operador lo abre a mano y esto guarda lo que se ve. Solo el árbol, sin captura, y nunca una
 * lista de la barra de arriba ni de los paneles laterales (`OPEN_LIST_EXCLUDED`). No hace clic ni
 * escribe nada. Se usa con la página ya reconocida como formulario.
 */
export async function captureOpenLists(
  page: Page,
  dir: string,
  name: string,
): Promise<MarketplaceListsEvidence> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const form = await formLocator(page);
  const parts = [`# formulario\n${await form.ariaSnapshot({ timeout: 10_000 })}`];
  const lists = page.locator(OPEN_LIST).filter({ visible: true });
  for (const list of await lists.all()) {
    const outside = await list.evaluate(
      (node, excluded) => node.closest(excluded) === null,
      OPEN_LIST_EXCLUDED,
    );
    if (!outside) continue;
    parts.push(
      `# lista desplegada ${parts.length}\n${await list.ariaSnapshot({ timeout: 10_000 })}`,
    );
  }
  const aria = join(dir, `${name}.aria.yml`);
  await writeFile(aria, `${parts.join("\n\n")}\n`, { mode: 0o600 });
  return { aria, lists: parts.length - 1 };
}

/**
 * Lo que se anota de una página donde el sistema se detuvo: solo la ruta, sin consulta ni
 * fragmento (pueden traer datos) y sin captura (puede mostrar el correo o el teléfono).
 */
export const stopRecord = (page: Page) => ({ path: pathOf(page.url()) });
