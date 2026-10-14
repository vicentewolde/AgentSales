import { isAppError, type MarketplaceFormPlan } from "@agentsales/core";
import type { Locator, Page } from "playwright";
import { MARKETPLACE_ERRORS } from "./errors.js";
import { captureFormEvidence, formLocator } from "./evidence.js";
import { requireForm } from "./guard.js";
import {
  CONTROL_WAIT_MS,
  FILL_PAUSE_MS,
  FORM_CONTROLS,
  type FormControl,
  NEVER_CLICK,
  OPEN_LIST_EXCLUDED,
  PHOTO_COUNT_TEXT,
  PHOTO_INPUT,
  PHOTO_INPUT_IMAGES,
  PHOTOS_WAIT_MS,
} from "./selectors.js";

export type FillMarketplaceOptions = {
  /** Dónde se guarda la captura si un control no aparece (`tmp/marketplace/<publicationId>/`). */
  evidenceDir: string;
  /** La pausa fija entre controles (D6); 0 en los tests. */
  pauseMs?: number;
  /** Cuánto espera cada control y las miniaturas. */
  controlWaitMs?: number;
  photosWaitMs?: number;
  /** Cuánto espera la lista blanca antes de cada paso (la página puede estar redibujándose). */
  guardWaitMs?: number;
};

/** Minúsculas y sin tildes, para comparar el texto de una opción con la comuna. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** El nombre de un control en los mensajes (sin `/…/i`). */
const nameOf = (control: FormControl) => {
  const value = control.name;
  return typeof value === "string" ? value : value.source.replace(/[\\^$]/g, "");
};

/**
 * Llena el formulario de propiedades con el plan (spec F5 §4.4, pasos 4 y 5; F5-T09) y sube las
 * fotos. Antes de cada paso, la lista blanca (`requireForm`): ante un inicio de sesión, una
 * verificación o cualquier otra pantalla, se detiene con su error. Entre controles, una pausa fija
 * (D6). Un control que no aparece da `MARKETPLACE_FORM_CHANGED` con la captura del formulario.
 * **Nunca** hace clic en Siguiente ni Publicar (`NEVER_CLICK`): solo en los desplegables y sus
 * opciones. No envía nada: el formulario queda lleno, a la vista del operador.
 */
export async function fillMarketplaceForm(
  page: Page,
  plan: MarketplaceFormPlan,
  photoPaths: readonly string[],
  options: FillMarketplaceOptions,
): Promise<void> {
  const pauseMs = options.pauseMs ?? FILL_PAUSE_MS;
  const waitMs = options.controlWaitMs ?? CONTROL_WAIT_MS;
  const guard = () => requireForm(page, { timeoutMs: options.guardWaitMs ?? 5_000 });
  const pause = () => (pauseMs > 0 ? page.waitForTimeout(pauseMs) : Promise.resolve());

  /**
   * El control a la vista **dentro del formulario** (nunca en la barra de Facebook: D5), o `null` si
   * es opcional y no está; si falta uno obligatorio, se detiene.
   */
  const find = async (control: FormControl): Promise<Locator | null> => {
    const root = await formLocator(page);
    const locator = root
      .getByRole(control.kind === "text" ? "textbox" : "combobox", { name: control.name })
      .first();
    try {
      await locator.waitFor({ state: "visible", timeout: control.optional ? 1_000 : waitMs });
      return locator;
    } catch {
      if (control.optional) return null;
      throw await formChanged(`no apareció «${nameOf(control)}»`);
    }
  };

  /** `MARKETPLACE_FORM_CHANGED` con la captura del formulario (si sigue siendo el formulario). */
  const formChanged = async (detail: string) => {
    await guard();
    await captureFormEvidence(page, options.evidenceDir, "control-faltante").catch(() => undefined);
    return MARKETPLACE_ERRORS.formChanged(detail);
  };

  /** Hace clic en un control solo si no es Siguiente ni Publicar (D3). */
  const safeClick = async (locator: Locator, what: string) => {
    const label = `${(await locator.getAttribute("aria-label")) ?? ""} ${await locator.innerText()}`;
    if (NEVER_CLICK.test(label)) throw await formChanged(`«${what}» parece un botón de enviar`);
    await locator.click();
  };

  const select = async (control: FormControl & { kind: "select" }, value: string) => {
    const box = await find(control);
    if (box === null) return;
    await safeClick(box, nameOf(control));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const [option] = await visibleOptions(page.getByRole("option", { name: value, exact: true }));
      if (option !== undefined) {
        await safeClick(option, value);
        return;
      }
      if (Date.now() >= deadline) {
        throw await formChanged(`«${nameOf(control)}» no tiene la opción «${value}»`);
      }
      await page.waitForTimeout(250);
    }
  };

  const type = async (control: FormControl & { kind: "text" }, value: string | number | null) => {
    if (value === null) return;
    const field = await find(control);
    if (field === null) return;
    await field.fill(String(value));
  };

  const place = async (control: FormControl & { kind: "place" }, query: string, comuna: string) => {
    const field = await find(control);
    if (field === null) return;
    await field.fill(query);
    const wanted = plain(comuna);
    const suggestions = page.getByRole("option");
    const deadline = Date.now() + waitMs;
    for (;;) {
      // Primero la sugerencia que **empieza** por la comuna ("Ñuñoa, Santiago…"); si no hay, una que
      // la nombre en otra parte. Así "Villa Ñuñoa" o "Santiago Centro" no ganan a la comuna misma.
      let exact: Locator | undefined;
      let partial: Locator | undefined;
      for (const suggestion of await visibleOptions(suggestions)) {
        const text = plain(await suggestion.innerText().catch(() => ""));
        if ((text.split(",")[0] ?? "").trim() === wanted) {
          exact = suggestion;
          break;
        }
        if (partial === undefined && text.includes(wanted)) partial = suggestion;
      }
      const chosen = exact ?? partial;
      if (chosen !== undefined) {
        await safeClick(chosen, comuna);
        return;
      }
      if (Date.now() >= deadline) {
        throw await formChanged(`«${nameOf(control)}» no sugirió la comuna`);
      }
      await page.waitForTimeout(250);
    }
  };

  const { location } = plan;
  const steps: Array<() => Promise<void>> = [
    () => select(FORM_CONTROLS.propertyType, plan.propertyType),
    () => type(FORM_CONTROLS.bedrooms, plan.bedrooms),
    () => type(FORM_CONTROLS.bathrooms, plan.bathrooms),
    () => type(FORM_CONTROLS.price, plan.priceClp),
    () =>
      place(
        FORM_CONTROLS.location,
        plan.address ?? [location.comuna, location.region].filter(Boolean).join(", "),
        location.comuna,
      ),
    () => type(FORM_CONTROLS.description, plan.description),
    () => type(FORM_CONTROLS.area, plan.areaSquareFeet),
    async () =>
      uploadPhotos(
        await formLocator(page),
        page,
        photoPaths,
        options.photosWaitMs ?? PHOTOS_WAIT_MS,
        formChanged,
      ),
  ];
  for (const [index, step] of steps.entries()) {
    await guard();
    try {
      await step();
    } catch (error) {
      if (isAppError(error)) throw error;
      // Un error de Playwright a mitad de un paso (la página cambió bajo el control): se detiene.
      throw await formChanged("un control dejó de responder");
    }
    if (index < steps.length - 1) await pause();
  }
}

/**
 * Las opciones a la vista que puede tocar el llenado: las de los desplegables y sugerencias del
 * formulario (Facebook las dibuja aparte), **nunca** las de la barra de arriba ni de los paneles
 * laterales (`OPEN_LIST_EXCLUDED`: ahí están los menús de la cuenta). Ni su texto se lee.
 */
async function visibleOptions(options: Locator): Promise<Locator[]> {
  const usable: Locator[] = [];
  for (const option of await options.all()) {
    const ok = await option
      .evaluate((node, excluded) => node.closest(excluded) === null, OPEN_LIST_EXCLUDED)
      .catch(() => false);
    if (ok && (await option.isVisible().catch(() => false))) usable.push(option);
  }
  return usable;
}

/** Cuántas fotos dice el contador del formulario («Se han adjuntado N fotos»), o `null` si no lo ve. */
async function attachedPhotos(root: Locator): Promise<number | null> {
  const status = root.getByRole("status").filter({ hasText: PHOTO_COUNT_TEXT });
  if ((await status.count()) === 0) return null;
  const match = PHOTO_COUNT_TEXT.exec(
    await status
      .first()
      .innerText()
      .catch(() => ""),
  );
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Sube las fotos con `setInputFiles` y espera a que el contador del formulario diga que se
 * adjuntaron (spec F5 §4.4, paso 5). Usa el control de fotos que acepta imágenes (el formulario real
 * trae dos) y, si ninguno lo declara, el primero.
 */
async function uploadPhotos(
  root: Locator,
  page: Page,
  photoPaths: readonly string[],
  waitMs: number,
  formChanged: (detail: string) => Promise<Error>,
): Promise<void> {
  const images = root.locator(PHOTO_INPUT_IMAGES);
  const input = ((await images.count()) > 0 ? images : root.locator(PHOTO_INPUT)).first();
  if ((await input.count()) === 0) throw await formChanged("no apareció el control de fotos");
  // Lo que ya había (fotos de un borrador) no cuenta: se esperan las nuevas.
  const before = (await attachedPhotos(root)) ?? 0;
  await input.setInputFiles([...photoPaths]);
  const deadline = Date.now() + waitMs;
  while (((await attachedPhotos(root)) ?? 0) < before + photoPaths.length) {
    if (Date.now() >= deadline) throw await formChanged("no se vieron todas las fotos cargadas");
    await page.waitForTimeout(250);
  }
}
