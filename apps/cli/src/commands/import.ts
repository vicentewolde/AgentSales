import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type ImportRunView, importRunResponseSchema } from "@agentsales/api/contracts";
import { IMPORT_RUN_STATUS_TEXT, isTerminalImportRun } from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { exitCodeOf, renderImportRun } from "./import-run-view.js";
import { brokerSlugOf } from "./shared.js";

/** Tiempos de la espera (spec F1 §4.4); los tests los acortan. */
export const IMPORT_WAIT = {
  pollMs: 2_000,
  queuedWarningMs: 20_000,
  maxWaitMs: 2 * 60 * 60 * 1000,
  /** Consultas seguidas que pueden fallar (API reiniciándose, Neon despertando) antes de rendirse. */
  maxPollFailures: 3,
};

export type ImportOptions = {
  media?: string;
  broker?: string;
  dryRun?: boolean;
  /** `--no-wait` lo deja en `false`. */
  wait?: boolean;
};

export type ImportDeps = Io & {
  client: ApiClient;
  /** Base de las rutas relativas (`INIT_CWD`). */
  cwd: string;
  sleep: (ms: number) => Promise<void>;
  /** Reloj monótono en milisegundos (un cambio de hora no adelanta ni atrasa el tope). */
  now: () => number;
  wait?: Partial<typeof IMPORT_WAIT>;
};

async function kindOf(path: string): Promise<"file" | "dir" | "other" | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? "file" : info.isDirectory() ? "dir" : "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new CliError("IMPORT_FILE_INVALID", `No se pudo leer ${path}`);
  }
}

/**
 * Rutas absolutas resueltas contra `cwd`, verificadas antes de llamar a la API: el xlsx es un
 * archivo `.xlsx`, y `--media` una carpeta o un `.zip`.
 */
export async function resolveImportPaths(
  cwd: string,
  xlsx: string,
  media: string | undefined,
): Promise<{ xlsxPath: string; mediaDir?: string }> {
  const xlsxPath = resolve(cwd, xlsx);
  const xlsxKind = await kindOf(xlsxPath);
  if (xlsxKind === null) {
    throw new CliError("IMPORT_FILE_NOT_FOUND", `No existe el archivo ${xlsxPath}`);
  }
  if (xlsxKind !== "file" || !xlsxPath.toLowerCase().endsWith(".xlsx")) {
    throw new CliError("IMPORT_FILE_INVALID", `${xlsxPath} no es un Excel (.xlsx)`);
  }
  if (media === undefined) return { xlsxPath };

  const mediaDir = resolve(cwd, media);
  const mediaKind = await kindOf(mediaDir);
  if (mediaKind === null) {
    throw new CliError("MEDIA_FOLDER_NOT_FOUND", `No existe ${mediaDir}`);
  }
  if (mediaKind === "other" || (mediaKind === "file" && !mediaDir.toLowerCase().endsWith(".zip"))) {
    throw new CliError(
      "MEDIA_FOLDER_INVALID",
      `--media debe ser una carpeta o un .zip: ${mediaDir}`,
    );
  }
  return { xlsxPath, mediaDir };
}

/** Puede volver a consultar: la API no respondió, o respondió un error de su lado (503, 500). */
const isTransient = (error: unknown) =>
  error instanceof ApiCallError && (error.status === undefined || error.status >= 500);

/**
 * `agentsales import <xlsx>`: pide la carga por `POST /imports/local` y espera a que el worker la
 * termine, consultando `/imports/:id` cada 2 s. Al final muestra el resumen y los errores.
 */
export function runImport(deps: ImportDeps, xlsx: string, options: ImportOptions = {}) {
  const c = deps.colors;
  const timing = { ...IMPORT_WAIT, ...deps.wait };
  return guarded(deps, async () => {
    const paths = await resolveImportPaths(deps.cwd, xlsx, options.media);
    const broker = options.broker === undefined ? undefined : brokerSlugOf(options.broker);

    const created = await unwrap(
      deps.client.imports.local.$post({
        json: { ...paths, ...(broker ? { broker } : {}), dryRun: options.dryRun ?? false },
      }),
      importRunResponseSchema,
    ).catch((error: unknown) => {
      if (error instanceof ApiCallError && error.code === "ROUTE_NOT_FOUND") {
        throw new CliError(
          "LOCAL_IMPORTS_DISABLED",
          "La API no acepta cargas desde la CLI (solo con NODE_ENV=development)",
          "Levanta la API con pnpm dev, o sube los archivos desde el panel",
        );
      }
      throw error;
    });
    let run: ImportRunView = created.importRun;

    if (options.wait === false) {
      deps.print(run.id);
      deps.printError(c.dim(`→ Sigue su avance con: agentsales imports ${run.id}`));
      return 0;
    }

    if (broker !== undefined && broker !== options.broker) {
      deps.print(c.dim(`Corredor: ${broker}`));
    }
    deps.print(`Carga ${run.id} (${run.input.xlsxFile}): ${IMPORT_RUN_STATUS_TEXT[run.status]}…`);
    const started = deps.now();
    let shown = run.status;
    let warned = false;
    let failures = 0;
    while (!isTerminalImportRun(run.status)) {
      if (deps.now() - started >= timing.maxWaitMs) {
        deps.print(c.yellow(`Sigue en curso: revisa más tarde con agentsales imports ${run.id}`));
        return 1;
      }
      await deps.sleep(timing.pollMs);
      try {
        run = (
          await unwrap(
            deps.client.imports[":id"].$get({ param: { id: run.id } }),
            importRunResponseSchema,
          )
        ).importRun;
        failures = 0;
      } catch (error) {
        failures += 1;
        if (!isTransient(error)) throw error;
        if (failures >= timing.maxPollFailures) {
          // La API no responde: la carga sigue (o no) en el worker, que no depende de ella.
          deps.printError(
            c.yellow(`Dejé de esperar; revisa la carga más tarde con agentsales imports ${run.id}`),
          );
          throw error;
        }
        continue;
      }
      if (run.status !== shown && !isTerminalImportRun(run.status)) {
        deps.print(`${IMPORT_RUN_STATUS_TEXT[run.status]}…`);
      }
      shown = run.status;
      if (run.status === "queued" && !warned && deps.now() - started >= timing.queuedWarningMs) {
        warned = true;
        deps.print(c.yellow("Sigue en cola: ¿está corriendo el worker? (pnpm dev)"));
      }
    }
    deps.print("");
    deps.print(renderImportRun(run, c));
    return exitCodeOf(run);
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("import")
    .description("Carga un Excel de propiedades, con sus fotos y videos, y espera el resultado")
    .argument("<xlsx>", "Excel con las hojas Propiedades y Corredor")
    .option("--media <carpeta|zip>", "carpeta o .zip con una subcarpeta por propiedad")
    .option("--broker <slug>", "corredor existente (si la hoja Corredor viene vacía)")
    .option("--dry-run", "simula la carga: valida y muestra el reporte sin guardar nada")
    .option("--no-wait", "imprime el id de la carga y sale sin esperar")
    .action((xlsx: string, options: ImportOptions) =>
      exitWith(() =>
        runImport(
          {
            ...ctx,
            client: ctx.api(),
            sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
            now: () => performance.now(),
          },
          xlsx,
          options,
        ),
      ),
    );
}
