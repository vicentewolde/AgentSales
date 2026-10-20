import {
  AppError,
  assertBrokerHoldsListings,
  type BrokerRepository,
  type ImportRun,
  type ImportRunRepository,
  importInputSummary,
  type JobQueue,
  type MediaStorage,
  requestImportUpload,
  startImport,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth.js";
import {
  type ImportRunListResponse,
  type ImportRunResponse,
  type ImportRunView,
  type ImportUploadResponse,
  idParamSchema,
  importUploadRequestSchema,
} from "../contracts/index.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";

export type ImportRoutesDeps = {
  importRuns: ImportRunRepository;
  /**
   * El corredor de un usuario corredor (spec F7 §4.4): su carga nace con él. Y el pedido (F9): a una
   * marca no se le cargan propiedades.
   */
  brokers: Pick<BrokerRepository, "findById" | "findBySlug">;
  queue: JobQueue;
  /** Firmar las subidas, revisar que llegaron y borrarlas si la cola falla (spec F8 §4.4). */
  storage: Pick<MediaStorage, "signedUploadUrl" | "list" | "delete">;
  /** uuid de la carga: se necesita antes de crearla, para las claves de R2. */
  newId: () => string;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo. */
  maxUploadBytes: number;
};

/** La carga como la ven la CLI y el panel: la entrada solo con nombres (nunca rutas ni claves). */
function viewOf(run: ImportRun): ImportRunView {
  return { ...run, input: importInputSummary(run.input) };
}

/**
 * `/imports` (spec F1 §4.4 y F8 §4.4, ADR-0025): la API pide la carga con sus URLs de subida y la
 * empieza cuando los archivos están en R2; ningún archivo pasa por aquí. El worker corre la carga.
 */
export function importRoutes(deps: ImportRoutesDeps) {
  /**
   * El corredor de la carga: el del usuario corredor (`broker` del pedido, si viene, tiene que ser
   * el suyo: si no, 404 como un corredor que no existe); el administrador, el del pedido o la hoja
   * Corredor. Una marca (F9, ADR-0029) no tiene propiedades: `BROKER_IS_BRAND` (409) antes de
   * pedir la subida (el job también lo revisa, por la hoja Corredor).
   */
  const brokerOf = async (
    c: Context<AppEnv>,
    requested: string | undefined,
  ): Promise<{ slug: string | null; brokerId: string | null }> => {
    const scope = requestScope(c);
    if (scope.kind === "all") {
      const asked = requested === undefined ? null : await deps.brokers.findBySlug(requested);
      if (asked !== null) assertBrokerHoldsListings(asked);
      return { slug: requested ?? null, brokerId: null };
    }
    const own = await deps.brokers.findById(scope.brokerId);
    if (own === null || (requested !== undefined && requested !== own.slug)) {
      throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${requested ?? ""}`.trim(), {
        details: { broker: requested },
      });
    }
    assertBrokerHoldsListings(own);
    return { slug: own.slug, brokerId: own.id };
  };

  return (
    new Hono<AppEnv>()
      .post("/uploads", validated("json", importUploadRequestSchema), async (c) => {
        const { broker, dryRun, xlsx, media } = c.req.valid("json");
        const owner = await brokerOf(c, broker);
        const { run, uploads } = await requestImportUpload(
          {
            importRuns: deps.importRuns,
            storage: deps.storage,
            newId: deps.newId,
            maxFileBytes: deps.maxUploadBytes,
          },
          {
            broker: owner.slug,
            brokerId: owner.brokerId,
            dryRun: dryRun ?? false,
            xlsx,
            media: media ?? null,
          },
        );
        const body: ImportUploadResponse = { importRun: viewOf(run), uploads };
        return c.json(body, 201);
      })
      // El dueño lo revisa `ownership.importRun` (`/imports/:id/*`): lo ajeno es 404.
      .post("/:id/start", validated("param", idParamSchema), async (c) => {
        const { id } = c.req.valid("param");
        const run = await startImport(
          { importRuns: deps.importRuns, storage: deps.storage, queue: deps.queue },
          { importRunId: id },
        );
        const body: ImportRunResponse = { importRun: viewOf(run) };
        return c.json(body, 202);
      })
      .get("/", async (c) => {
        const body: ImportRunListResponse = {
          importRuns: (await deps.importRuns.list(50, requestScope(c))).map((run) => {
            const { report: _report, ...summary } = viewOf(run);
            return summary;
          }),
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
      })
  );
}
