import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import {
  createSecretBox,
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
  resolveBrowserProfilesDir,
} from "@agentsales/config";
import {
  createBrokerRepository,
  createContentRepository,
  createDb,
  createListingRepository,
  createMediaRepository,
  createPlatformAccountRepository,
  createPublicationRepository,
} from "@agentsales/db";
import { marketplaceProfileDir, openMarketplaceProfile } from "@agentsales/publishers/marketplace";
import { createBancoCentralUf } from "@agentsales/publishers/uf";
import { createR2Storage } from "@agentsales/storage";
import { runFbSmoke } from "../smoke/fb-smoke.js";
import { runFbSmokeListing } from "../smoke/fb-smoke-listing.js";
import { describeUnexpected } from "../smoke/ig-smoke.js";

// `pnpm fb:smoke --broker <slug>` (spec F5 §4.8, F5-T03): abre con ventana el perfil de Facebook del
// corredor, espera a que inicies sesión a mano si hace falta y guarda en `tmp/fb-smoke/` la captura
// y el árbol de accesibilidad del formulario de propiedades, sin llenar nada ni hacer clic. Con
// `--menus`, después espera a que abras a mano cada menú y aprietes Enter, y guarda lo que se ve.
// Con `--listing <id_propiedad>` (spec F5 §4.8), llena el formulario real con ese aviso, después de
// tu s/N (o `--yes`), y deja la ventana abierta hasta que la cierres: nunca hace Siguiente ni
// Publicar, ni cambia estados en AgentSales.
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
    options: {
      broker: { type: "string" },
      menus: { type: "boolean", default: false },
      listing: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  if (values.listing !== undefined && values.menus) {
    throw new Error("--menus no va con --listing: --listing llena el formulario de una propiedad");
  }
  if (values.listing === undefined && values.yes) {
    throw new Error("--yes solo va con --listing");
  }
  if (values.broker === undefined && values.listing === undefined) {
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
  const openProfile = (brokerId: string) =>
    openMarketplaceProfile({ dir: marketplaceProfileDir(profilesRoot, brokerId) });
  const outputDir = join(workspaceRoot, "tmp", "fb-smoke");
  if (values.listing !== undefined) {
    // `--listing`: lee la base y R2 (sin escribir en ellas) y el valor de la UF; llena el formulario.
    process.exitCode = await runFbSmokeListing(
      {
        brokers: createBrokerRepository(db.db),
        listings: createListingRepository(db.db),
        accounts: createPlatformAccountRepository(db.db, {
          secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
        }),
        contents: createContentRepository(db.db),
        media: createMediaRepository(db.db),
        storage: createR2Storage({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucket: env.R2_BUCKET,
          signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
        }),
        publications: createPublicationRepository(db.db),
        uf:
          env.BCCH_API_TOKEN === undefined
            ? null
            : createBancoCentralUf({ token: env.BCCH_API_TOKEN }),
        dailyLimit: env.MARKETPLACE_DAILY_LIMIT,
        openProfile,
        outputDir,
        ask,
        now: () => new Date(),
        print: (line) => console.log(line),
        printError: (line) => console.error(line),
      },
      {
        listingRef: values.listing,
        ...(values.broker === undefined ? {} : { brokerSlug: values.broker }),
        yes: values.yes,
        signal: abort.signal,
      },
    );
  } else {
    process.exitCode = await runFbSmoke(
      {
        brokers: createBrokerRepository(db.db),
        openProfile,
        outputDir,
        now: () => new Date(),
        print: (line) => console.log(line),
        printError: (line) => console.error(line),
        ask,
      },
      { brokerSlug: values.broker ?? "", signal: abort.signal, menus: values.menus },
    );
  }
} catch (error) {
  // Un `.env` inválido, una opción desconocida o un fallo inesperado: el mensaje, sin la pila ni URLs.
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
} finally {
  terminal?.close();
  await database?.close();
}
