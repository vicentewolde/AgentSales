import { homedir } from "node:os";
import { join } from "node:path";
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
// y el árbol de accesibilidad del formulario de propiedades, sin llenar nada ni hacer clic. Habla con
// Facebook de verdad: lo corre el operador, en la terminal de su Mac. No necesita `pnpm dev` (lee el
// corredor de la base, sin escribir) y no mira `PUBLISH_MODE`: no publica (ADR-0017 punto 7).

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (abort.signal.aborted) process.exit(130);
    console.error("\nCortando…");
    abort.abort();
  });
}

let database: ReturnType<typeof createDb> | undefined;
try {
  const { values } = parseArgs({ options: { broker: { type: "string" } } });
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
    },
    { brokerSlug: values.broker, signal: abort.signal },
  );
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila ni URLs.
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
} finally {
  await database?.close();
}
