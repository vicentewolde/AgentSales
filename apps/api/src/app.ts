import type {
  BrokerRepository,
  FieldDefinitionRepository,
  HealthCheckName,
  ImportRunRepository,
  JobQueue,
  ListingRepository,
  MediaRepository,
  MediaStorage,
  PublishMode,
} from "@agentsales/core";
import { Hono } from "hono";
import { createErrorHandler, notFoundHandler } from "./errors.js";
import { type HealthCheck, runHealth } from "./health.js";
import type { AppLogger } from "./logger.js";
import { requestLogger } from "./request-logger.js";
import { brokerRoutes } from "./routes/brokers.js";
import { type ImportUploads, importRoutes } from "./routes/imports.js";
import { listingRoutes } from "./routes/listings.js";
import { csrfGuard, hostGuard, type LocalAccess } from "./security.js";

export type AppDeps = {
  checks: Record<HealthCheckName, HealthCheck>;
  publishMode: PublishMode;
  version: string;
  logger: AppLogger;
  /** Hosts y orígenes locales permitidos (`localAccess(API_PORT, WEB_PORT)`). */
  access: LocalAccess;
  /** Solo para tests; por defecto `DEFAULT_CHECK_TIMEOUT_MS`. */
  checkTimeoutMs?: number;
  // Puertos de core (no los adaptadores): así `AppType` no arrastra drizzle ni el SDK de S3.
  listings: ListingRepository;
  brokers: BrokerRepository;
  media: MediaRepository;
  fieldDefinitions: FieldDefinitionRepository;
  /** Solo para las URLs de lectura temporales de las fotos. */
  storage: Pick<MediaStorage, "signedReadUrl">;
  // Importación (F1-T11): la API solo crea el run y encola (ADR-0005).
  importRuns: ImportRunRepository;
  queue: JobQueue;
  /** Escribe y borra en el staging; lo compone `server.ts` (lo que depende de Node). */
  uploads: ImportUploads;
  newId: () => string;
  /** `POST /imports/local`: `server.ts` lo activa con `NODE_ENV=development`. */
  localImports: boolean;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes. */
  maxUploadBytes: number;
};

/** Arma la API con sus dependencias inyectadas. Las rutas van encadenadas para el cliente `hc`. */
export function createApp(deps: AppDeps) {
  const app = new Hono()
    .use(requestLogger(deps.logger))
    .use(hostGuard(deps.access.allowedHosts))
    .use(csrfGuard(deps.access.allowedOrigins))
    .get("/health", async (c) => {
      const report = await runHealth({
        checks: deps.checks,
        publishMode: deps.publishMode,
        version: deps.version,
        ...(deps.checkTimeoutMs === undefined ? {} : { timeoutMs: deps.checkTimeoutMs }),
      });
      // Siempre 200: el estado va en el cuerpo (`ok` o `degraded`).
      return c.json(report, 200);
    })
    // Encadenadas con `.route()`, así `AppType` conserva el esquema de cada ruta (ADR-0011).
    .route("/listings", listingRoutes(deps))
    .route("/brokers", brokerRoutes(deps))
    .route("/imports", importRoutes(deps));
  app.onError(createErrorHandler(deps.logger));
  app.notFound(notFoundHandler);
  return app;
}

/** Tipo de la API para el cliente RPC (`hc<AppType>`) de la CLI y el panel. */
export type AppType = ReturnType<typeof createApp>;
