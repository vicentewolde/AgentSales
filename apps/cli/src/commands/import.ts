import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ImportRunView,
  importRunResponseSchema,
  importUploadResponseSchema,
} from "@agentsales/api/contracts";
import { IMPORT_RUN_STATUS_TEXT, isTerminalImportRun } from "@agentsales/core";
import type { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded } from "../output.js";
import { buildImportManifest, createNodePutFile, type PutFile, uploadAll } from "../upload.js";
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
  /** El `PUT` a R2 de cada archivo (por defecto `node:http(s)`; los tests pasan un doble). */
  putFile?: PutFile;
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
): Promise<{ xlsxPath: string; media?: { kind: "zip" | "dir"; path: string } }> {
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
  return { xlsxPath, media: { kind: mediaKind === "dir" ? "dir" : "zip", path: mediaDir } };
}

const megabytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString("es-CL", { maximumFractionDigits: 1 })} MB`;

/**
 * `agentsales import <xlsx>` (spec F8 §4.5, ADR-0025): pide la carga (`POST /imports/uploads`),
 * sube la planilla y los medios directo a R2 con avance, la empieza (`POST /imports/:id/start`) y
 * espera a que el worker la termine, consultando `/imports/:id` cada 2 s. Al final muestra el
 * resumen y los errores. `--dry-run` usa el mismo camino: el worker valida sin guardar.
 */
export function runImport(deps: ImportDeps, xlsx: string, options: ImportOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const paths = await resolveImportPaths(deps.cwd, xlsx, options.media);
    const broker = options.broker === undefined ? undefined : brokerSlugOf(options.broker);
    const manifest = await buildImportManifest(paths.xlsxPath, paths.media);

    const requested = await unwrap(
      deps.client.imports.uploads.$post({
        json: {
          ...manifest.request,
          ...(broker ? { broker } : {}),
          dryRun: options.dryRun ?? false,
        },
      }),
      importUploadResponseSchema,
    );
    const totalBytes = [...manifest.files.values()].reduce((total, file) => total + file.size, 0);
    // La subida y su avance van a la salida de errores (con `--no-wait`, la normal queda solo con
    // el id), de a 25 %, para no llenar la pantalla.
    deps.printError(
      c.dim(`Subiendo ${requested.uploads.length} archivo(s) (${megabytes(totalBytes)}) a R2…`),
    );
    let lastQuarter = 0;
    await uploadAll(requested.uploads, manifest.files, {
      putFile: deps.putFile ?? createNodePutFile(),
      sleep: deps.sleep,
      onProgress: ({ sentBytes, totalBytes: total, doneFiles, totalFiles }) => {
        const quarter = total === 0 ? 4 : Math.floor((sentBytes / total) * 4);
        if (quarter > lastQuarter && quarter < 4) {
          lastQuarter = quarter;
          deps.printError(c.dim(`  ${quarter * 25} % (${doneFiles} de ${totalFiles} archivos)`));
        }
      },
    });
    const created = await unwrap(
      deps.client.imports[":id"].start.$post({ param: { id: requested.importRun.id } }),
      importRunResponseSchema,
    );
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
