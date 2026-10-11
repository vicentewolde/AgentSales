import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type BrokerRepository, isAppError } from "@agentsales/core";
import {
  captureFormEvidence,
  captureOpenLists,
  classifyPage,
  hasSession,
  MARKETPLACE_FORM_URL,
  type MarketplacePageKind,
  type MarketplaceProfile,
  pathOf,
  requireForm,
  stopErrorOf,
  waitForSession,
} from "@agentsales/publishers/marketplace";
import { describeUnexpected } from "./ig-smoke.js";

/** Cuánto espera a que el operador inicie sesión en la ventana. */
export const FB_SMOKE_LOGIN_WAIT_MS = 10 * 60_000;

/** Con `--menus`, cuántas capturas guarda como máximo (cada una, cuando el operador aprieta Enter). */
export const FB_SMOKE_MAX_MENU_CAPTURES = 10;

export type FbSmokeDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  /** Abre el perfil de Marketplace del corredor (con ventana; los tests, sin ella). */
  openProfile(brokerId: string): Promise<MarketplaceProfile>;
  /** `<workspace>/tmp/fb-smoke`: donde queda la evidencia. */
  outputDir: string;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
  /**
   * Se llama con el perfil todavía abierto, justo antes de cerrarlo (los tests miran la página:
   * que no se escribió nada ni se hizo clic).
   */
  beforeClose?(profile: MarketplaceProfile): Promise<void>;
  /**
   * Con `--menus`: muestra la pregunta en la terminal y devuelve lo que escribió el operador, o
   * `null` si la entrada se cortó (Ctrl+C o Ctrl+D).
   */
  ask?(question: string): Promise<string | null>;
  /** Esperas: inyectables para los tests. */
  loginWaitMs?: number;
  pollMs?: number;
  formWaitMs?: number;
};

export type FbSmokeOptions = {
  brokerSlug: string;
  signal?: AbortSignal;
  /**
   * `--menus`: con el formulario guardado, espera a que el operador abra a mano un menú (operación,
   * tipo de propiedad) y apriete Enter, y guarda lo que se ve (spec F5 §4.8).
   */
  menus?: boolean;
};

/** Lo que queda en `summary.json`: sin cookies, sin la consulta de la dirección, sin datos de la cuenta. */
type FbSmokeSummary = {
  checkedAt: string;
  outcome: "form" | Exclude<MarketplacePageKind, "form">;
  /** La ruta donde terminó (sin consulta). */
  finalPath: string;
  /** Si existe la cookie de sesión y si su valor es un número (nunca el valor). */
  sessionCookie: { present: boolean; numeric: boolean };
  files: string[];
};

/**
 * `pnpm fb:smoke --broker <slug>` (spec F5 §4.8, F5-T03): lo corre el operador para conocer el
 * formulario real de Marketplace, que sin sesión no se ve.
 * 1. Abre el perfil del corredor con ventana (si otro proceso lo tiene, se detiene).
 * 2. Va al formulario. Si Facebook pide iniciar sesión, le pide al operador hacerlo **a mano** en la
 *    ventana (también su 2FA) y espera hasta 10 min a que haya sesión: la cookie y una página que no
 *    sea de inicio de sesión ni de verificación. Nada se escribe en la página.
 * 3. Con sesión, vuelve al formulario y aplica la lista blanca: ante una verificación, un captcha,
 *    Marketplace no disponible u otra página, se detiene (sin captura: solo la ruta).
 * 4. Con el formulario a la vista, guarda la captura y el árbol de accesibilidad **del formulario**
 *    y un resumen en `tmp/fb-smoke/`.
 * 5. Con `--menus`, el operador abre a mano los menús del formulario (las opciones de un menú cerrado
 *    no salen en el árbol) y, cada vez que aprieta Enter, se guarda el árbol del formulario y de la
 *    lista desplegada (`captura-N.aria.yml`), hasta que escribe "listo".
 * 6. Cierra la ventana. **No llena nada, no hace clic y no escribe en la base.** No mira
 *    `PUBLISH_MODE` (no publica; ADR-0017 punto 7).
 * Devuelve el código de salida: 0 si guardó el formulario, 1 si no.
 */
export async function runFbSmoke(deps: FbSmokeDeps, options: FbSmokeOptions): Promise<number> {
  const broker = await deps.brokers.findBySlug(options.brokerSlug);
  if (broker === null) {
    deps.printError(`✗ No existe el corredor ${options.brokerSlug}`);
    return 1;
  }
  let profile: MarketplaceProfile | undefined;
  try {
    profile = await deps.openProfile(broker.id);
    const { page } = profile;
    deps.print(`Se abrió una ventana de Chromium con el perfil de Facebook de ${broker.name}.`);
    await page.goto(MARKETPLACE_FORM_URL);
    if (!(await hasSession(profile))) {
      deps.print(
        "Inicia sesión en Facebook en esa ventana (también el código de verificación si te lo pide).",
      );
      deps.print(
        "El sistema no escribe nada: solo espera a que la sesión quede abierta (hasta 10 min).",
      );
      await waitForSession(profile, {
        timeoutMs: deps.loginWaitMs ?? FB_SMOKE_LOGIN_WAIT_MS,
        pollMs: deps.pollMs ?? 2_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onVerification: () =>
          deps.print(
            "Facebook pide una verificación: resuélvela a mano en esa ventana (el sistema no la toca).",
          ),
      });
      deps.print("✓ Sesión abierta. Vuelvo al formulario de propiedades.");
      await page.goto(MARKETPLACE_FORM_URL);
    }
    const summary = await inspectForm(profile, deps);
    await writeSummary(deps, summary);
    if (summary.outcome !== "form") {
      deps.printError(`✗ ${stopErrorOf(summary.outcome).message}`);
      deps.printError(`  Se detuvo en ${summary.finalPath} (sin captura).`);
      return 1;
    }
    if (options.menus === true) await captureMenus(profile, deps, summary);
    deps.print(`✓ Formulario guardado en ${deps.outputDir}:`);
    for (const file of [...summary.files, "summary.json"]) deps.print(`  ${file}`);
    deps.print("No se llenó nada. Avísale a Claude: revisará solo el árbol del formulario.");
    return 0;
  } catch (error) {
    deps.printError(`✗ ${isAppError(error) ? error.message : describeUnexpected(error)}`);
    if (isAppError(error) && error.code === "MARKETPLACE_LOGIN_TIMEOUT") {
      deps.printError("  Vuelve a correr pnpm fb:smoke e inicia sesión en la ventana.");
    }
    return 1;
  } finally {
    if (profile !== undefined) {
      await deps.beforeClose?.(profile).catch(() => undefined);
      await profile.close();
    }
  }
}

/** Aplica la lista blanca y, si es el formulario, guarda su evidencia. */
async function inspectForm(
  profile: MarketplaceProfile,
  deps: FbSmokeDeps,
): Promise<FbSmokeSummary> {
  const { page } = profile;
  const base = {
    checkedAt: deps.now().toISOString(),
    sessionCookie: await profile.sessionCookie(),
  };
  try {
    await requireForm(page, { timeoutMs: deps.formWaitMs ?? 20_000 });
  } catch (error) {
    const kind = await classifyPage(page);
    if (kind === "form") throw error;
    return { ...base, outcome: kind, finalPath: pathOf(page.url()), files: [] };
  }
  const evidence = await captureFormEvidence(page, deps.outputDir, "formulario");
  return {
    ...base,
    outcome: "form",
    finalPath: pathOf(page.url()),
    // Solo los nombres: la ruta completa trae el usuario de la Mac.
    files: [basename(evidence.aria), basename(evidence.screenshot)],
  };
}

/**
 * `--menus`: el operador abre a mano un menú del formulario y aprieta Enter; se guarda el árbol del
 * formulario y de la lista desplegada. Antes de cada captura, la lista blanca: si la página dejó de
 * ser el formulario (una verificación, otra página), se detiene sin guardar. Cada captura queda
 * anotada en el resumen apenas se guarda.
 */
async function captureMenus(
  profile: MarketplaceProfile,
  deps: FbSmokeDeps,
  summary: FbSmokeSummary,
): Promise<void> {
  const { ask } = deps;
  if (ask === undefined) throw new Error("--menus necesita la terminal para preguntar");
  deps.print("");
  deps.print("Ahora tú, a mano en la ventana de Chromium:");
  deps.print(
    "  abre el menú de operación (venta o alquiler) o el de tipo de propiedad, y deja la lista a la vista.",
  );
  deps.print(
    "  También puedes elegir una opción para ver los campos que aparecen. El sistema no toca nada:",
  );
  deps.print("  solo guarda lo que se ve. Nunca hagas clic en Siguiente ni en Publicar.");
  for (let n = 1; n <= FB_SMOKE_MAX_MENU_CAPTURES; n++) {
    const answer = await ask(
      `Enter para guardar lo que se ve (captura ${n} de ${FB_SMOKE_MAX_MENU_CAPTURES}), o "listo" para terminar: `,
    );
    if (answer === null || answer.trim().toLowerCase() === "listo") break;
    const kind = await classifyPage(profile.page);
    if (kind !== "form") throw stopErrorOf(kind);
    const saved = await captureOpenLists(profile.page, deps.outputDir, `captura-${n}`);
    const file = basename(saved.aria);
    summary.files.push(file);
    await writeSummary(deps, summary);
    deps.print(
      saved.lists > 0
        ? `✓ Guardé ${file}: el formulario y ${saved.lists === 1 ? "1 lista desplegada" : `${saved.lists} listas desplegadas`}.`
        : `✓ Guardé ${file}: el formulario (no vi una lista desplegada; si abriste un menú, vuelve a intentarlo con la lista a la vista).`,
    );
  }
}

async function writeSummary(deps: FbSmokeDeps, summary: FbSmokeSummary): Promise<void> {
  await mkdir(deps.outputDir, { recursive: true, mode: 0o700 });
  await writeFile(join(deps.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
}
