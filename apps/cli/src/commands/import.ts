import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type ImportRunView, importRunResponseSchema } from "@agentsales/api/contracts";
import { IMPORT_RUN_STATUS_TEXT, isTerminalImportRun } from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded } from "../output.js";
import { exitCodeOf, renderImportRun } from "./import-run-view.js";
import { brokerSlugOf } from "./shared.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

export type ImportOptions = {
  media?: string;
  broker?: string;
  dryRun?: boolean;
  /** `--no-wait` lo deja en `false`. */
  wait?: boolean;
};

export type ImportDeps = WaitDeps & {
  client: ApiClient;
  /** Base de las rutas relativas (`INIT_CWD`). */
  cwd: string;
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

/**
 * `agentsales import <xlsx>`: pide la carga por `POST /imports/local` y espera a que el worker la
 * termine, consultando `/imports/:id` cada 2 s. Al final muestra el resumen y los errores.
 */
export function runImport(deps: ImportDeps, xlsx: string, options: ImportOptions = {}) {
  const c = deps.colors;
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
    const done = await waitForRun(deps, {
      run,
      fetch: async () =>
        (
          await unwrap(
            deps.client.imports[":id"].$get({ param: { id: run.id } }),
            importRunResponseSchema,
          )
        ).importRun,
      isTerminal: (current) => isTerminalImportRun(current.status),
      progress: (current) => IMPORT_RUN_STATUS_TEXT[current.status],
      laterCommand: `agentsales imports ${run.id}`,
      noun: "la carga",
    });
    if (done === null) return 1;
    run = done;
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
