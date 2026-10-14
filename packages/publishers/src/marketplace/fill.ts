import { isAppError, type MarketplaceFormPlan } from "@agentsales/core";
import type { Locator, Page } from "playwright";
import { MARKETPLACE_ERRORS, withoutPaths } from "./errors.js";
import { captureFormEvidence, captureOpenLists, formLocator } from "./evidence.js";
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

/**
 * Una foto para el formulario, **en memoria** (nombre, tipo y bytes): se adjunta como datos, no como
 * ruta, porque Facebook la sube después de adjuntarla y un archivo temporal ya borrado haría
 * fallar esa subida (2026-10-14).
 */
export type MarketplacePhoto = { name: string; mimeType: string; buffer: Buffer };

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
  /** Solo para investigar un fallo (`fb:smoke --listing --diagnostico sin-fotos`): no sube las fotos. */
  skipPhotos?: boolean;
};

/** Cuántas veces baja con la flecha antes de rendirse (una lista de sugerencias es corta). */
const MAX_ARROW_PRESSES = 10;
/** Cuánto espera a que la lista deje de cambiar antes de usar una calle como referencia de la comuna. */
const FALLBACK_SETTLE_MS = 1_500;
/** Cuánto espera a que la primera sugerencia de una dirección deje de cambiar antes de elegirla. */
const ADDRESS_SETTLE_MS = 800;
/** Cuánto intenta el clic en una sugerencia antes de pasar al teclado. */
const CLICK_FALLBACK_MS = 3_000;

/** Frases del error de Playwright que explican por qué un control no respondió, en palabras simples. */
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/intercepts pointer events/i, "otro elemento tapa el control"],
  [/element is not visible/i, "el control no se ve"],
  [/element is not stable/i, "el control se mueve"],
  [/outside of the viewport/i, "el control quedó fuera de la pantalla"],
  [/element is not enabled|element is disabled/i, "el control está deshabilitado"],
  [/detached from the dom/i, "el control desapareció de la página"],
];

/** Por qué falló, si el error lo dice con una frase conocida; nada del texto de la página. */
const reasonOf = (error: unknown): string | null => {
  const text = error instanceof Error ? error.message : String(error);
  return REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
};

/**
 * La opción resaltada de una lista (por `aria-activedescendant` del campo o `aria-selected`), o
 * `null` si la lista no lo dice.
 */
async function highlightedOption(
  page: Page,
  field: Locator,
  timeout: number,
): Promise<string | null> {
  const id = await field.getAttribute("aria-activedescendant", { timeout }).catch(() => null);
  if (id !== null && id !== "") {
    const active = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`).first();
    const text = await active.innerText({ timeout }).catch(() => "");
    return text === "" ? null : plain(text);
  }
  const [selected] = await visibleOptions(page.locator('[role="option"][aria-selected="true"]'));
  if (selected === undefined) return null;
  const text = await selected.innerText({ timeout }).catch(() => "");
  return text === "" ? null : plain(text);
}

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
  photos: readonly MarketplacePhoto[],
  options: FillMarketplaceOptions,
): Promise<{ notes: string[] }> {
  /** Avisos para el operador (por ejemplo, que la ubicación se eligió con una calle de referencia). */
  const notes: string[] = [];
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
    // Las listas desplegadas (sugerencias de la dirección, opciones) viven fuera del formulario.
    await captureOpenLists(page, options.evidenceDir, "listas-abiertas").catch(() => undefined);
    return MARKETPLACE_ERRORS.formChanged(detail);
  };

  /** Hace clic en un control solo si no es Siguiente ni Publicar (D3). */
  const safeClick = async (locator: Locator, what: string, timeout = waitMs) => {
    const label = `${(await locator.getAttribute("aria-label", { timeout })) ?? ""} ${await locator.innerText({ timeout })}`;
    if (NEVER_CLICK.test(label)) throw await formChanged(`«${what}» parece un botón de enviar`);
    await locator.click({ timeout });
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
   * El campo de dirección es una búsqueda en el mapa: al escribir, Facebook abre una lista («N
   * búsquedas sugeridas») de lugares reales con la forma `Calle, <código postal> <Comuna>, Región…,
   * Chile` (OBSERVADO con sesión, 2026-10-14), y hay que elegir una. Reglas (spec F5 §4.6 y D16):
   * - **Con dirección** (`hasAddress`): se escribe la dirección tal como está en la planilla (calle,
   *   número, comuna y región) y se hace clic en **la primera sugerencia que aparece**, tenga o no
   *   la comuna (decisión del operador, 2026-10-14: siempre aparece alguna). Se espera a que la
   *   primera opción deje de cambiar. El clic respeta `NEVER_CLICK` como cualquier otro.
   * - **Sin dirección**: solo se conoce la comuna, y la primera sugerencia podría ser cualquier
   *   calle con ese nombre. Entonces se elige la comuna misma (su primer segmento, sin el código
   *   postal pegado) y, si Facebook no la ofrece (para «Providencia» ofreció solo calles llamadas
   *   Providencia), una **calle sin número cuya localidad es la comuna**, como referencia aproximada,
   *   con una nota para que el operador revise la ubicación. Nunca una calle con número ni de otra
   *   comuna.
   * Si no aparece ninguna sugerencia que sirva, espera hasta el tope y se detiene con
   * `MARKETPLACE_FORM_CHANGED`.
   */
  const place = async (
    control: FormControl & { kind: "place" },
    query: string,
    comuna: string,
    hasAddress: boolean,
  ) => {
    const field = await find(control);
    if (field === null) return;
    await field.fill(query, { timeout: waitMs });
    const wanted = plain(comuna);
    /** La primera línea de la opción, partida por comas y sin el código postal pegado a la comuna. */
    const parse = (suggestion: string) => {
      const title = suggestion.split(/\n+/)[0] ?? "";
      const original = title.split(",").map((segment) => segment.trim());
      return {
        segments: original.map((segment) => plain(segment).replace(/^\d{5,8}\s+/, "")),
        street: original[0] ?? "",
      };
    };
    /** 2: sirve; 1: una calle de la comuna como referencia (solo sin dirección); 0: no sirve. */
    const rank = (suggestion: string): 0 | 1 | 2 => {
      if (hasAddress) return 2;
      const { segments } = parse(suggestion);
      if (segments[0] === wanted) return 2;
      const first = segments[0] ?? "";
      return segments.length > 1 && !/\d/.test(first) && segments.slice(1).includes(wanted) ? 1 : 0;
    };
    const suggestions = page.getByRole("option");
    const deadline = Date.now() + waitMs;
    const settleMs = Math.min(
      hasAddress ? ADDRESS_SETTLE_MS : FALLBACK_SETTLE_MS,
      Math.floor(waitMs / 2),
    );
    // Desde cuándo lo mejor visible es lo mismo: la lista puede seguir actualizándose.
    let seenText: string | null = null;
    let seenSince = 0;
    for (;;) {
      let best: { option: Locator; rank: 1 | 2; text: string } | undefined;
      for (const option of await visibleOptions(suggestions)) {
        const text = await option.innerText({ timeout: waitMs }).catch(() => "");
        const r = rank(text);
        if (r === 2) {
          best = { option, rank: 2, text };
          break;
        }
        if (r === 1 && best === undefined) best = { option, rank: 1, text };
      }
      const timedOut = Date.now() >= deadline;
      if (best === undefined) {
        seenText = null;
      } else if (seenText !== best.text) {
        seenText = best.text;
        seenSince = Date.now();
      }
      // Se espera a que lo elegido se estabilice; una comuna exacta sin dirección se toma de inmediato.
      const settled = best !== undefined && Date.now() - seenSince >= settleMs;
      const immediate = best?.rank === 2 && !hasAddress;
      if (best !== undefined && (immediate || settled || timedOut)) {
        // El teclado ve el texto resaltado ya normalizado: se compara igual.
        const target = plain(best.text);
        try {
          // El clic recibe poco tiempo: si algo tapa la lista o se mueve, se pasa al teclado.
          await safeClick(best.option, comuna, Math.min(waitMs, CLICK_FALLBACK_MS));
        } catch (error) {
          if (isAppError(error)) throw error;
          await pickByKeyboard(field, (text) => text === target, nameOf(control));
        }
        if (best.rank === 1) {
          notes.push(
            `La dirección no está en la planilla y Facebook no ofreció la comuna como ubicación: se usó una calle de ${comuna} («${parse(best.text).street}») como referencia aproximada. Revisa la ubicación antes de seguir.`,
          );
        }
        return;
      }
      if (timedOut) {
        throw await formChanged(
          `«${nameOf(control)}» ${hasAddress ? "no mostró ninguna sugerencia" : "no sugirió la comuna"}`,
        );
      }
      await page.waitForTimeout(250);
    }
  };

  /**
   * Elige con el teclado (flecha abajo y Enter), como se usa cualquier lista desplegable, cuando el
   * clic no se puede hacer. **Solo aprieta Enter si la opción resaltada es la que corresponde** y no
   * se llama como Siguiente o Publicar; si la lista no dice cuál está resaltada, se detiene en vez
   * de adivinar (`aria-activedescendant` o `aria-selected`).
   */
  const pickByKeyboard = async (
    field: Locator,
    fits: (suggestion: string) => boolean,
    what: string,
  ) => {
    await field.focus({ timeout: waitMs });
    for (let presses = 0; presses < MAX_ARROW_PRESSES; presses++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(100);
      const active = await highlightedOption(page, field, waitMs);
      if (active === null) {
        throw await formChanged(`«${what}» no dice cuál sugerencia está resaltada`);
      }
      if (NEVER_CLICK.test(active)) throw await formChanged(`«${what}» parece un botón de enviar`);
      if (fits(active)) {
        await page.keyboard.press("Enter");
        return;
      }
    }
    throw await formChanged(`«${what}» no sugirió la comuna`);
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
          // La dirección tal cual está en la planilla; sin ella, la comuna y la región.
          [plan.address, location.comuna, location.region].filter(Boolean).join(", "),
          location.comuna,
          plan.address !== null,
        ),
    },
    { name: "descripción", run: () => type(FORM_CONTROLS.description, plan.description) },
    { name: "superficie", run: () => type(FORM_CONTROLS.area, plan.areaSquareFeet) },
    {
      name: "fotos",
      run: async () => {
        if (options.skipPhotos === true) return;
        await uploadPhotos(
          await formLocator(page),
          page,
          photos,
          options.photosWaitMs ?? PHOTOS_WAIT_MS,
          formChanged,
        );
      },
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
      const reason = reasonOf(error);
      throw await formChanged(
        `un control dejó de responder en el paso «${step.name}» (${withoutPaths(error).slice(0, 200)}${reason === null ? "" : `; ${reason}`})`,
      );
    }
    if (index < steps.length - 1) await pause();
  }
  return { notes };
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
  photos: readonly MarketplacePhoto[],
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
  await input.setInputFiles(photos.map((photo) => ({ ...photo })));
  const started = Date.now();
  for (;;) {
    const now = await attachedPhotos(root);
    if (now !== null && now >= (before ?? 0) + photos.length) return;
    const elapsed = Date.now() - started;
    if (now === null && before === null && elapsed >= Math.min(waitMs, PHOTO_COUNTER_WAIT_MS)) {
      throw await formChanged("no apareció el contador de fotos adjuntas");
    }
    if (elapsed >= waitMs) throw await formChanged("no se vieron todas las fotos cargadas");
    await page.waitForTimeout(250);
  }
}
