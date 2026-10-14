import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { pathOf } from "./guard.js";
import {
  FORM_CONTAINER,
  FORM_ELEMENT,
  FORM_FIELD,
  FORM_ROOT,
  OPEN_LIST,
  OPEN_LIST_EXCLUDED,
  PHOTO_INPUT,
} from "./selectors.js";

/** Lo que quedó guardado de una página: los archivos, por nombre. */
export type MarketplaceEvidence = {
  /** Captura PNG del formulario. */
  screenshot: string;
  /** Árbol de accesibilidad del formulario (YAML de Playwright). */
  aria: string;
  /** Cuántas líneas tiene el árbol: uno casi vacío es señal de que se tomó el trozo equivocado. */
  ariaLines: number;
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
  const tree = (await form.ariaSnapshot({ timeout: 10_000 })).trim();
  await writeFile(aria, `${tree}\n`, { mode: 0o600 });
  return { screenshot, aria, ariaLines: tree === "" ? 0 : tree.split("\n").length };
}

/**
 * El formulario: el contenedor **más chico** (un `form` o el contenedor principal) que trae el
 * control de fotos y además otros campos. Así, si Facebook pone las fotos en un `form` aparte, no
 * se toma ese trozo vacío. Si ninguno trae campos, el primero con el control de fotos.
 */
export async function formLocator(page: Page) {
  const withFields = page
    .locator(FORM_ROOT)
    .filter({ has: page.locator(PHOTO_INPUT) })
    .filter({ has: page.locator(FORM_FIELD) });
  // En el orden del documento, un contenedor va antes que lo que contiene: el último es el más chico.
  if ((await withFields.count()) > 0) return withFields.last();
  const element = page.locator(FORM_ELEMENT);
  return ((await element.count()) > 0 ? element : page.locator(FORM_CONTAINER)).first();
}

/** Un contenedor del control de fotos, sin textos: solo su forma. */
export type MarketplaceShapeStep = {
  tag: string;
  role: string | null;
  /** Cuántos campos (que no son fotos) y controles de fotos trae adentro. */
  fields: number;
  photoInputs: number;
};

/**
 * La forma de la página alrededor del control de fotos, de adentro hacia afuera: etiqueta, rol y
 * cuántos campos trae cada contenedor. **Sin textos, ids ni clases**: si el árbol sale vacío o
 * incompleto, esto dice dónde está el formulario de verdad sin guardar nada del operador. Va en
 * `summary.json` de `fb:smoke`.
 */
export async function describeFormShape(page: Page): Promise<MarketplaceShapeStep[]> {
  const input = page.locator(PHOTO_INPUT).first();
  if ((await input.count()) === 0) return [];
  return input
    .evaluate(
      (node, selectors) => {
        const steps: Array<{
          tag: string;
          role: string | null;
          fields: number;
          photoInputs: number;
        }> = [];
        for (let el = node.parentElement; el !== null && steps.length < 25; el = el.parentElement) {
          steps.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            fields: el.querySelectorAll(selectors.field).length,
            photoInputs: el.querySelectorAll(selectors.photo).length,
          });
        }
        return steps;
      },
      { field: FORM_FIELD, photo: PHOTO_INPUT },
    )
    .catch(() => []);
}

/** Lo que guardó `captureOpenLists`: el archivo y cuántas listas desplegadas vio. */
export type MarketplaceListsEvidence = { aria: string; lists: number };

/**
 * Guarda en `<name>.aria.yml` el árbol del formulario y el de cada lista desplegada **del
 * formulario** a la vista (`fb:smoke --menus`, spec F5 §4.8): las opciones de un menú cerrado no
 * salen en el árbol, así que el operador lo abre a mano y esto guarda lo que se ve. Solo el árbol,
 * sin captura. Una lista vale si está dentro del formulario o si un control del formulario está
 * desplegado (`aria-expanded="true"`), y nunca si está en la barra de arriba o en un panel lateral
 * (`OPEN_LIST_EXCLUDED`): así el menú de la cuenta (con el nombre del operador) no entra. Una lista
 * dentro de otra se guarda una vez, con la de afuera. No hace clic ni escribe nada. Se usa con la
 * página ya reconocida como formulario.
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
    // Una lista que desaparece mientras tanto (el operador la cerró) se salta.
    const belongs = await list
      .evaluate(
        (node, selectors) => {
          if (node.closest(selectors.excluded) !== null) return false;
          if (node.parentElement?.closest(selectors.openList) != null) return false;
          if (node.closest(selectors.form) !== null) return true;
          const form = node.ownerDocument.querySelector(selectors.form);
          return form?.querySelector('[aria-expanded="true"]') != null;
        },
        { excluded: OPEN_LIST_EXCLUDED, openList: OPEN_LIST, form: FORM_ROOT },
        { timeout: 3_000 },
      )
      .catch(() => false);
    if (!belongs) continue;
    const tree = await list.ariaSnapshot({ timeout: 3_000 }).catch(() => null);
    if (tree !== null) parts.push(`# lista desplegada ${parts.length}\n${tree}`);
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
