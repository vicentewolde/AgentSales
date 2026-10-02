import {
  AppError,
  type ImportRun,
  type ImportRunRepository,
  type JobQueue,
  type NewImportRun,
  requestImport,
} from "@agentsales/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type ImportRunListResponse,
  type ImportRunResponse,
  type ImportRunView,
  idParamSchema,
  importUploadFormSchema,
  localImportBodySchema,
  MAX_XLSX_UPLOAD_BYTES,
} from "../contracts/index.js";
import { validated } from "../validation.js";

/** Lo que la API escribe en disco: lo compone `server.ts` con el staging (spec F1 §4.1). */
export type ImportUploads = {
  /** Guarda un archivo subido en `tmp/imports/{runId}/input/` y devuelve su ruta absoluta. */
  save(runId: string, fileName: string, bytes: Uint8Array): Promise<string>;
  /** Borra `tmp/imports/{runId}/`; no falla si no existe. */
  discard(runId: string): Promise<void>;
};

export type ImportRoutesDeps = {
  importRuns: ImportRunRepository;
  queue: JobQueue;
  uploads: ImportUploads;
  /** uuid para el run: se necesita antes de crearlo, para guardar los archivos. */
  newId: () => string;
  /** `POST /imports/local` solo en desarrollo (`NODE_ENV=development`, la CLI). */
  localImports: boolean;
  /** Tope de todo el cuerpo de `POST /imports` (`MAX_IMPORT_UPLOAD_MB`). */
  maxUploadBytes: number;
};

/** El último tramo de una ruta, con `/` o `\`: lo único que la API muestra de `input`. */
const fileNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

function viewOf(run: ImportRun): ImportRunView {
  return {
    ...run,
    input: {
      xlsxFile: fileNameOf(run.input.xlsxPath),
      mediaFile: run.input.mediaDir === null ? null : fileNameOf(run.input.mediaDir),
      broker: run.input.broker,
    },
  };
}

const invalidUpload = (message: string) => new AppError("REQUEST_INVALID", message);

/**
 * `/imports` (spec F1 §4.4, D2): la API solo crea el run y encola (`requestImport`); el worker
 * corre la carga. Responde `202` con el run en `queued`.
 */
export function importRoutes(deps: ImportRoutesDeps) {
  const request = (params: NewImportRun) =>
    requestImport(
      { importRuns: deps.importRuns, queue: deps.queue, discardStaging: deps.uploads.discard },
      params,
    );

  return new Hono()
    .post(
      "/",
      // El multipart se lee completo en memoria: el tope va antes de leerlo (413).
      bodyLimit({
        maxSize: deps.maxUploadBytes,
        onError: () => {
          throw new AppError(
            "REQUEST_TOO_LARGE",
            `La subida pasa de ${Math.round(deps.maxUploadBytes / 1024 / 1024)} MB`,
          );
        },
      }),
      validated("form", importUploadFormSchema),
      async (c) => {
        const { file, media, broker, dryRun } = c.req.valid("form");
        if (!file.name.toLowerCase().endsWith(".xlsx")) {
          throw invalidUpload("El archivo debe ser un Excel (.xlsx)");
        }
        if (file.size > MAX_XLSX_UPLOAD_BYTES) {
          throw invalidUpload(`El Excel pasa de ${MAX_XLSX_UPLOAD_BYTES / 1024 / 1024} MB`);
        }
        if (media !== undefined && !media.name.toLowerCase().endsWith(".zip")) {
          throw invalidUpload("Los medios deben venir en un .zip");
        }

        const id = deps.newId();
        let params: NewImportRun;
        try {
          const xlsxPath = await deps.uploads.save(
            id,
            file.name,
            new Uint8Array(await file.arrayBuffer()),
          );
          const mediaDir =
            media === undefined
              ? null
              : await deps.uploads.save(id, media.name, new Uint8Array(await media.arrayBuffer()));
          params = {
            id,
            source: "xlsx",
            fileName: fileNameOf(file.name),
            dryRun: dryRun === "true",
            input: { xlsxPath, mediaDir, broker: broker ?? null },
          };
        } catch (error) {
          await deps.uploads.discard(id).catch(() => undefined);
          throw error;
        }
        const run = await request(params).catch(async (error: unknown) => {
          // Si no se llegó a crear el run (la base no respondió), lo guardado queda huérfano.
          await deps.uploads.discard(id).catch(() => undefined);
          throw error;
        });
        const body: ImportRunResponse = { importRun: viewOf(run) };
        return c.json(body, 202);
      },
    )
    .post(
      "/local",
      // Fuera de desarrollo la ruta no existe: 404 antes de mirar el cuerpo.
      async (_c, next) => {
        if (!deps.localImports) {
          throw new AppError("ROUTE_NOT_FOUND", "No existe POST /imports/local");
        }
        await next();
      },
      validated("json", localImportBodySchema),
      async (c) => {
        const { xlsxPath, mediaDir, broker, dryRun } = c.req.valid("json");
        const run = await request({
          id: deps.newId(),
          source: "xlsx",
          fileName: fileNameOf(xlsxPath),
          dryRun: dryRun ?? false,
          input: { xlsxPath, mediaDir: mediaDir ?? null, broker: broker ?? null },
        });
        const body: ImportRunResponse = { importRun: viewOf(run) };
        return c.json(body, 202);
      },
    )
    .get("/", async (c) => {
      const body: ImportRunListResponse = {
        importRuns: (await deps.importRuns.list()).map(viewOf),
      };
      return c.json(body, 200);
    })
    .get("/:id", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const run = await deps.importRuns.get(id);
      if (run === null) {
        throw new AppError("IMPORT_RUN_NOT_FOUND", `No existe la carga ${id}`, {
          details: { importRunId: id },
        });
      }
      const body: ImportRunResponse = { importRun: viewOf(run) };
      return c.json(body, 200);
    });
}
