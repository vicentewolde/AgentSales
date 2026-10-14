import { isAppError, type MarketplaceFormPlan } from "@agentsales/core";
import type { Locator, Page } from "playwright";
import { MARKETPLACE_ERRORS, withoutPaths } from "./errors.js";
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
  PHOTO_COUNTER_WAIT_MS,
  PHOTO_INPUTS_BY_PREFERENCE,
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
    const label = `${(await locator.getAttribute("aria-label", { timeout: waitMs })) ?? ""} ${await locator.innerText({ timeout: waitMs })}`;
    if (NEVER_CLICK.test(label)) throw await formChanged(`«${what}» parece un botón de enviar`);
    await locator.click({ timeout: waitMs });
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
    await field.fill(String(value), { timeout: waitMs });
  };

  /**
   * El campo de dirección es una búsqueda en el mapa: al escribir, Facebook abre una lista de
   * direcciones reales y hay que elegir una. Reglas (spec F5 §4.6):
   * - **Dirección oculta** (`street` es `null`): solo una sugerencia que sea la comuna misma (su
   *   primer segmento es la comuna: «La Reina, Región Metropolitana…»). Nunca una calle con número:
   *   revelaría una ubicación que el aviso no quiere mostrar.
   * - **Dirección visible**: una sugerencia que nombre la calle (lo que va antes del número) y tenga
   *   la comuna como un segmento entero. Si no hay, se detiene: nunca elige otra calle.
   * Si ninguna calza, espera hasta el tope y se detiene con `MARKETPLACE_FORM_CHANGED`.
   */
  const place = async (
    control: FormControl & { kind: "place" },
    query: string,
    comuna: string,
    street: string | null,
  ) => {
    const field = await find(control);
    if (field === null) return;
    await field.fill(query, { timeout: waitMs });
    const wanted = plain(comuna);
    const streetName = street === null ? null : plain(street.split(/\d/)[0] ?? "").trim();
    const suggestions = page.getByRole("option");
    const deadline = Date.now() + waitMs;
    for (;;) {
      let exact: Locator | undefined;
      for (const suggestion of await visibleOptions(suggestions)) {
        const text = plain(await suggestion.innerText({ timeout: waitMs }).catch(() => ""));
        const segments = text.split(",").map((segment) => segment.trim());
        const fits =
          street === null
            ? segments[0] === wanted
            : segments.includes(wanted) && (streetName === "" || text.includes(streetName ?? ""));
        if (fits) {
          exact = suggestion;
          break;
        }
      }
      if (exact !== undefined) {
        await safeClick(exact, comuna);
        return;
      }
      if (Date.now() >= deadline) {
        throw await formChanged(`«${nameOf(control)}» no sugirió la comuna`);
      }
      await page.waitForTimeout(250);
    }
  };

  const { location } = plan;
  // Cada paso lleva su nombre: si Playwright falla a mitad de uno, el error dice cuál.
  const steps: Array<{ name: string; run: () => Promise<void> }> = [
    { name: "tipo de propiedad", run: () => select(FORM_CONTROLS.propertyType, plan.propertyType) },
    { name: "dormitorios", run: () => type(FORM_CONTROLS.bedrooms, plan.bedrooms) },
    { name: "baños", run: () => type(FORM_CONTROLS.bathrooms, plan.bathrooms) },
    { name: "precio", run: () => type(FORM_CONTROLS.price, plan.priceClp) },
    {
      name: "dirección",
      run: () =>
        place(
          FORM_CONTROLS.location,
          plan.address ?? [location.comuna, location.region].filter(Boolean).join(", "),
          location.comuna,
          plan.address,
        ),
    },
    { name: "descripción", run: () => type(FORM_CONTROLS.description, plan.description) },
    { name: "superficie", run: () => type(FORM_CONTROLS.area, plan.areaSquareFeet) },
    {
      name: "fotos",
      run: async () =>
        uploadPhotos(
          await formLocator(page),
          page,
          photoPaths,
          options.photosWaitMs ?? PHOTOS_WAIT_MS,
          formChanged,
        ),
    },
  ];
  for (const [index, step] of steps.entries()) {
    await guard();
    try {
      await step.run();
    } catch (error) {
      if (isAppError(error)) throw error;
      // Un error de Playwright a mitad de un paso (la página cambió bajo el control): se detiene y
      // dice en qué paso y la primera línea del error (sin rutas; no trae datos del aviso).
      throw await formChanged(
        `un control dejó de responder en el paso «${step.name}» (${withoutPaths(error).slice(0, 200)})`,
      );
    }
    if (index < steps.length - 1) await pause();
  }
}

/**
 * Las opciones a la vista que puede tocar el llenado: las de los desplegables y sugerencias del
 * formulario (Facebook las dibuja aparte), **nunca** las de la barra de arriba ni de los paneles
 * laterales (`OPEN_LIST_EXCLUDED`: ahí están los menús de la cuenta), que ni se miran. El texto de
 * las que sí se miran no se registra en ningún log ni error.
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
 * adjuntaron (spec F5 §4.4, paso 5). Usa el control de archivo que acepta imágenes y no videos (el
 * formulario real trae dos); si el contador no aparece o no sube, se detiene con
 * `MARKETPLACE_FORM_CHANGED` en vez de dar las fotos por subidas sin verlo.
 */
async function uploadPhotos(
  root: Locator,
  page: Page,
  photoPaths: readonly string[],
  waitMs: number,
  formChanged: (detail: string) => Promise<Error>,
): Promise<void> {
  let input: Locator | undefined;
  for (const selector of PHOTO_INPUTS_BY_PREFERENCE) {
    const candidates = root.locator(selector);
    if ((await candidates.count()) > 0) {
      input = candidates.first();
      break;
    }
  }
  if (input === undefined) throw await formChanged("no apareció el control de fotos");
  // Lo que ya había (fotos de un borrador) no cuenta: se esperan las nuevas.
  const before = await attachedPhotos(root);
  await input.setInputFiles([...photoPaths]);
  const started = Date.now();
  for (;;) {
    const now = await attachedPhotos(root);
    if (now !== null && now >= (before ?? 0) + photoPaths.length) return;
    const elapsed = Date.now() - started;
    if (now === null && before === null && elapsed >= Math.min(waitMs, PHOTO_COUNTER_WAIT_MS)) {
      throw await formChanged("no apareció el contador de fotos adjuntas");
    }
    if (elapsed >= waitMs) throw await formChanged("no se vieron todas las fotos cargadas");
    await page.waitForTimeout(250);
  }
}
