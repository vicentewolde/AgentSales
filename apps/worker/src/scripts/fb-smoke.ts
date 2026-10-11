import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import {
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
  resolveBrowserProfilesDir,
} from "@agentsales/config";
import { createBrokerRepository, createDb } from "@agentsales/db";
import { marketplaceProfileDir, openMarketplaceProfile } from "@agentsales/publishers/marketplace";
import { runFbSmoke } from "../smoke/fb-smoke.js";
import { describeUnexpected } from "../smoke/ig-smoke.js";

// `pnpm fb:smoke --broker <slug>` (spec F5 §4.8, F5-T03): abre con ventana el perfil de Facebook del
// corredor, espera a que inicies sesión a mano si hace falta y guarda en `tmp/fb-smoke/` la captura
// y el árbol de accesibilidad del formulario de propiedades, sin llenar nada ni hacer clic. Con
// `--menus`, después espera a que abras a mano cada menú y aprietes Enter, y guarda lo que se ve.
// Habla con Facebook de verdad: lo corre el operador, en la terminal de su Mac. No necesita
// `pnpm dev` (lee el corredor de la base, sin escribir) y no mira `PUBLISH_MODE`: no publica
// (ADR-0017 punto 7).

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (abort.signal.aborted) process.exit(130);
    console.error("\nCortando…");
    abort.abort();
  });
}

// La terminal para `--menus`, abierta recién en la primera pregunta. Mientras está abierta, Ctrl+C
// llega a ella (no al proceso): corta igual y la pregunta pendiente responde `null`.
let terminal: Interface | undefined;
const ask = (question: string) =>
  new Promise<string | null>((resolve) => {
    if (abort.signal.aborted) {
      resolve(null);
      return;
    }
    if (terminal === undefined) {
      const created = createInterface({ input: process.stdin, output: process.stdout });
      created.on("SIGINT", () => {
        console.error("\nCortando…");
        abort.abort();
      });
      terminal = created;
    }
    const current = terminal;
    // Un corte de cualquier lado (Ctrl+C en la terminal, SIGTERM) cierra la terminal, y cerrarla
    // responde `null` a la pregunta pendiente.
    const onAbort = () => current.close();
    const onClose = () => {
      abort.signal.removeEventListener("abort", onAbort);
      resolve(null);
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    current.once("close", onClose);
    current.question(question, (answer) => {
      abort.signal.removeEventListener("abort", onAbort);
      current.off("close", onClose);
      resolve(answer);
    });
  });

let database: ReturnType<typeof createDb> | undefined;
try {
  const { values } = parseArgs({
    options: { broker: { type: "string" }, menus: { type: "boolean", default: false } },
  });
  if (values.broker === undefined) {
    throw new Error("Falta --broker <slug>: el corredor cuyo perfil de Facebook se abre");
  }
  loadEnvFile();
  const env = loadEnv();
  const workspaceRoot = findWorkspaceRoot();
  const profilesRoot = resolveBrowserProfilesDir(env.BROWSER_PROFILES_DIR, {
    homeDir: homedir(),
    workspaceRoot,
  });
  const db = createDb(env.DATABASE_URL);
  database = db;
  process.exitCode = await runFbSmoke(
    {
      brokers: createBrokerRepository(db.db),
      openProfile: (brokerId) =>
        openMarketplaceProfile({ dir: marketplaceProfileDir(profilesRoot, brokerId) }),
      outputDir: join(workspaceRoot, "tmp", "fb-smoke"),
      now: () => new Date(),
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
      ask,
    },
    { brokerSlug: values.broker, signal: abort.signal, menus: values.menus },
  );
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila ni URLs.
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
} finally {
  terminal?.close();
  await database?.close();
}
