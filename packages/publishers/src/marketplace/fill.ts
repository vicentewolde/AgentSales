import { isAppError, type MarketplaceFormPlan } from "@agentsales/core";
import type { Locator, Page } from "playwright";
import { MARKETPLACE_ERRORS } from "./errors.js";
import { captureFormEvidence } from "./evidence.js";
import { requireForm } from "./guard.js";
import {
  CONTROL_WAIT_MS,
  FILL_PAUSE_MS,
  FORM_CONTROLS,
  type FormControl,
  NEVER_CLICK,
  PHOTO_INPUT,
  PHOTO_THUMBNAIL,
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
  const value = control.kind === "select" ? control.name : control.label;
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

  /** El control a la vista, o `null` si es opcional y no está; si falta uno obligatorio, se detiene. */
  const find = async (control: FormControl): Promise<Locator | null> => {
    const locator = (
      control.kind === "select"
        ? page.getByRole("combobox", { name: control.name })
        : page.getByLabel(control.label)
    ).first();
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
    const option = page.getByRole("option", { name: value, exact: true }).first();
    try {
      await option.waitFor({ state: "visible", timeout: waitMs });
    } catch {
      throw await formChanged(`«${nameOf(control)}» no tiene la opción «${value}»`);
    }
    await safeClick(option, value);
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
      for (const suggestion of await suggestions.all()) {
        const text = plain(await suggestion.innerText().catch(() => ""));
        if (text.includes(wanted) && (await suggestion.isVisible())) {
          await safeClick(suggestion, comuna);
          return;
        }
      }
      if (Date.now() >= deadline) {
        throw await formChanged(`«${nameOf(control)}» no sugirió la comuna`);
      }
      await page.waitForTimeout(250);
    }
  };

  const { location } = plan;
  const steps: Array<() => Promise<void>> = [
    () => select(FORM_CONTROLS.operation, plan.operation),
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
    () => type(FORM_CONTROLS.area, plan.areaM2 === null ? null : Math.round(plan.areaM2)),
    () => type(FORM_CONTROLS.title, plan.title),
    () => type(FORM_CONTROLS.description, plan.description),
    () => uploadPhotos(page, photoPaths, options.photosWaitMs ?? PHOTOS_WAIT_MS, formChanged),
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

/** Sube las fotos con `setInputFiles` y espera a ver una miniatura por foto (spec F5 §4.4, paso 5). */
async function uploadPhotos(
  page: Page,
  photoPaths: readonly string[],
  waitMs: number,
  formChanged: (detail: string) => Promise<Error>,
): Promise<void> {
  const input = page.locator(PHOTO_INPUT).first();
  if ((await input.count()) === 0) throw await formChanged("no apareció el control de fotos");
  await input.setInputFiles([...photoPaths]);
  const deadline = Date.now() + waitMs;
  while ((await page.locator(PHOTO_THUMBNAIL).count()) < photoPaths.length) {
    if (Date.now() >= deadline) throw await formChanged("no se vieron todas las fotos cargadas");
    await page.waitForTimeout(250);
  }
}
