import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createErrorThrottle,
  createLogger,
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
} from "@agentsales/config";
import type { RunImportDeps } from "@agentsales/core";
import {
  createBrokerRepository,
  createDb,
  createFieldDefinitionRepository,
  createImportRunRepository,
  createListingRepository,
  createMediaRepository,
  toPgConnectionString,
} from "@agentsales/db";
import { readListingsWorkbook } from "@agentsales/importers";
import { createStaging } from "@agentsales/importers/staging";
import { createBoss } from "@agentsales/queue";
import { createR2Storage } from "@agentsales/storage";
import { IMPORT_ABANDONED, IMPORT_RUN_ABANDONED_AFTER_MS } from "./jobs/import-run.js";
import { buildJobs } from "./jobs/index.js";
import { registerJobs } from "./jobs/registry.js";

/** Tiempo que se espera a que terminen los jobs en curso al apagar. */
const GRACEFUL_STOP_MS = 30_000;

loadEnvFile();
const env = loadEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
  name: "worker",
});

// Dependencias de los jobs: se componen aquí, en el punto de entrada (ADR-0010).
const dbErrors = createErrorThrottle(logger, "error de la base de datos");
const database = createDb(env.DATABASE_URL, { onError: (error) => dbErrors.report(error) });
const importRuns = createImportRunRepository(database.db);
// `pnpm --filter` corre cada app en su carpeta: el staging se resuelve contra la raíz (spec §4.1).
const staging = createStaging({
  root: join(findWorkspaceRoot(), "tmp", "imports"),
  maxVideoBytes: env.MAX_VIDEO_MB * 1024 * 1024,
});
const importRun: RunImportDeps = {
  brokers: createBrokerRepository(database.db),
  listings: createListingRepository(database.db),
  importRuns,
  fieldDefinitions: createFieldDefinitionRepository(database.db),
  media: createMediaRepository(database.db),
  storage: createR2Storage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
  }),
  sha256: async (text) => createHash("sha256").update(text, "utf8").digest("hex"),
  readSheet: (input) => readListingsWorkbook(input.xlsxPath),
  openMedia: (request) => staging.openMedia(request),
  discardStaging: (runId) => staging.discard(runId),
};
const jobs = buildJobs({ importRun });

const boss = createBoss({
  connectionString: toPgConnectionString(env.DATABASE_URL),
  role: "worker",
});
// Sin conexión, pg-boss reintenta cada 1–2 s y emite un error por intento: se resumen.
const bossErrors = createErrorThrottle(logger, "error de pg-boss");
boss.on("error", (error) => bossErrors.report(error));
boss.on("warning", (warning) => logger.warn({ warning }, "aviso de pg-boss"));

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  bossErrors.dispose();
  dbErrors.dispose();
  logger.info({ signal }, "apagando el worker: esperando los jobs en curso");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se fuerza la salida");
    process.exit(1);
  }, GRACEFUL_STOP_MS + 10_000);
  force.unref();
  try {
    // graceful: deja de tomar jobs nuevos y espera a los activos antes de cerrar el pool.
    await boss.stop({ graceful: true, timeout: GRACEFUL_STOP_MS });
    await database.close();
    logger.info("worker detenido");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error al detener pg-boss");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/**
 * Al arrancar (spec F1 §4.3 y §4.6), sin impedir que el worker procese jobs si algo falla:
 * 1. antes de conectar, borra el staging de más de 24 h (no necesita la base);
 * 2. ya conectado, cierra los runs abandonados en `running` y borra el staging de runs terminados.
 */
async function cleanStaging(withDatabase: boolean): Promise<void> {
  try {
    const removed = await staging.cleanup(
      withDatabase
        ? async (runId) => {
            const run = await importRuns.get(runId);
            if (run === null) return "missing";
            return run.status === "succeeded" || run.status === "failed" ? "closed" : "open";
          }
        : undefined,
    );
    if (removed.length > 0) logger.info({ removed: removed.length }, "staging limpiado");
  } catch (error) {
    logger.warn({ err: error }, "no se pudo limpiar el staging; se intenta al próximo arranque");
  }
}

async function failAbandonedRuns(): Promise<void> {
  try {
    const closed = await importRuns.failAbandoned(
      new Date(Date.now() - IMPORT_RUN_ABANDONED_AFTER_MS),
      IMPORT_ABANDONED,
    );
    if (closed.length > 0) logger.warn({ importRunIds: closed }, "cargas abandonadas cerradas");
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar las cargas abandonadas");
  }
}

try {
  await cleanStaging(false);
  await boss.start();
  await failAbandonedRuns();
  await cleanStaging(true);
  // Una señal durante el arranque: `shutdown` ya está deteniendo pg-boss; no se registra nada más.
  const registered =
    !shuttingDown && (await registerJobs(boss, jobs, logger, { isStopping: () => shuttingDown }));
  if (registered) {
    logger.info({ jobs: jobs.map((job) => job.name) }, "worker listo");
    logger.warn(
      "Mientras el worker corre, Neon no se suspende y consume CU-horas: apágalo al terminar (ADR-0007).",
    );
  }
} catch (error) {
  if (shuttingDown) {
    logger.debug({ err: error }, "arranque interrumpido por el apagado");
  } else {
    logger.error({ err: error }, "no se pudo arrancar el worker");
    process.exit(1);
  }
}
