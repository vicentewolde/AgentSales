import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrokerRepository, isAppError } from "@agentsales/core";
import {
  captureFormEvidence,
  classifyPage,
  MARKETPLACE_FORM_URL,
  type MarketplacePageKind,
  type MarketplaceProfile,
  pathOf,
  requireForm,
  SESSION_COOKIE,
  stopErrorOf,
} from "@agentsales/publishers/marketplace";
import { describeUnexpected } from "./ig-smoke.js";

/** Cuánto espera a que el operador inicie sesión en la ventana. */
export const FB_SMOKE_LOGIN_WAIT_MS = 10 * 60_000;

export type FbSmokeDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  /** Abre el perfil de Marketplace del corredor (con ventana; los tests, sin ella). */
  openProfile(brokerId: string): Promise<MarketplaceProfile>;
  /** `<workspace>/tmp/fb-smoke`: donde queda la evidencia. */
  outputDir: string;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
  /** Esperas: inyectables para los tests. */
  loginWaitMs?: number;
  pollMs?: number;
  formWaitMs?: number;
};

export type FbSmokeOptions = { brokerSlug: string; signal?: AbortSignal };

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
 *    y un resumen en `tmp/fb-smoke/`, y cierra la ventana. **No llena nada, no hace clic y no
 *    escribe en la base.** No mira `PUBLISH_MODE` (no publica; ADR-0017 punto 7).
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
      await waitForSession(profile, deps, options.signal);
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
    deps.print(`✓ Formulario guardado en ${deps.outputDir}:`);
    for (const file of summary.files) deps.print(`  ${file}`);
    deps.print("No se llenó nada. Avísale a Claude: revisará solo el árbol del formulario.");
    return 0;
  } catch (error) {
    deps.printError(`✗ ${isAppError(error) ? error.message : describeUnexpected(error)}`);
    return 1;
  } finally {
    await profile?.close();
  }
}

/** Hay sesión: la cookie con el id y una página que no pide iniciar sesión ni verificar. */
async function hasSession(profile: MarketplaceProfile): Promise<boolean> {
  if ((await profile.sessionUserId()) === null) return false;
  const kind = await classifyPage(profile.page);
  return kind !== "login" && kind !== "verification";
}

/** Espera a que el operador inicie sesión a mano, mirando cada `pollMs`; tope de 10 min. */
async function waitForSession(
  profile: MarketplaceProfile,
  deps: FbSmokeDeps,
  signal: AbortSignal | undefined,
): Promise<void> {
  const deadline = deps.now().getTime() + (deps.loginWaitMs ?? FB_SMOKE_LOGIN_WAIT_MS);
  for (;;) {
    if (signal?.aborted) throw new Error("Se cortó la espera");
    if (!profile.isOpen()) throw new Error("Se cerró la ventana antes de iniciar sesión");
    if (await hasSession(profile).catch(() => false)) return;
    if (deps.now().getTime() >= deadline) {
      throw new Error("Pasaron 10 minutos sin sesión: vuelve a correr pnpm fb:smoke");
    }
    await profile.page.waitForTimeout(deps.pollMs ?? 2_000).catch(() => undefined);
  }
}

/** Aplica la lista blanca y, si es el formulario, guarda su evidencia. */
async function inspectForm(
  profile: MarketplaceProfile,
  deps: FbSmokeDeps,
): Promise<FbSmokeSummary> {
  const { page } = profile;
  const cookieId = await profile.sessionUserId();
  const cookies = await profile.context.cookies("https://www.facebook.com");
  const base = {
    checkedAt: deps.now().toISOString(),
    sessionCookie: {
      present: cookies.some((cookie) => cookie.name === SESSION_COOKIE),
      numeric: cookieId !== null,
    },
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
    files: [evidence.aria, evidence.screenshot],
  };
}

async function writeSummary(deps: FbSmokeDeps, summary: FbSmokeSummary): Promise<void> {
  await mkdir(deps.outputDir, { recursive: true, mode: 0o700 });
  const path = join(deps.outputDir, "summary.json");
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  summary.files.push(path);
}
