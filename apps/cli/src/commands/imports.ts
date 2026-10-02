import { importRunListResponseSchema, importRunResponseSchema } from "@agentsales/api/contracts";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { formatDateTime, guarded, type Io, renderTable } from "../output.js";
import { exitCodeOf, paintStatus, renderImportRun } from "./import-run-view.js";

export type ImportsDeps = Io & { client: ApiClient };

/**
 * `agentsales imports [<id>]`: sin id, las últimas cargas (sin reporte); con id, el resumen y los
 * errores de esa carga, como al final de `import`.
 */
export function runImports(deps: ImportsDeps, id?: string) {
  const c = deps.colors;
  return guarded(deps, async () => {
    if (id !== undefined) {
      const { importRun } = await unwrap(
        deps.client.imports[":id"].$get({ param: { id } }),
        importRunResponseSchema,
      );
      deps.print(renderImportRun(importRun, c));
      return importRun.status === "queued" || importRun.status === "running"
        ? 0
        : exitCodeOf(importRun);
    }
    const { importRuns } = await unwrap(deps.client.imports.$get(), importRunListResponseSchema);
    if (importRuns.length === 0) {
      deps.print("Todavía no hay cargas. Empieza con: agentsales import <xlsx> --media <carpeta>");
      return 0;
    }
    deps.print(
      renderTable(
        [
          "Carga",
          "Creada",
          "Archivo",
          "Estado",
          "Creadas",
          "Actualizadas",
          "Sin cambios",
          "Con error",
        ],
        importRuns.map((run) => [
          run.id,
          formatDateTime(run.createdAt),
          run.input.xlsxFile,
          paintStatus(run, c),
          String(run.rowsCreated),
          String(run.rowsUpdated),
          String(run.rowsSkipped),
          run.rowsFailed > 0 ? c.red(String(run.rowsFailed)) : "0",
        ]),
        c,
      ),
    );
    deps.print(c.dim("→ El detalle de una carga: agentsales imports <id>"));
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("imports")
    .description("Historial de cargas, o el reporte de una")
    .argument("[id]", "id de la carga")
    .action((id: string | undefined) =>
      exitWith(() => runImports({ ...ctx, client: ctx.api() }, id)),
    );
}
