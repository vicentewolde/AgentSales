import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { toPgConnectionString } from "@agentsales/db";
import { createBoss } from "@agentsales/queue";
import { createErrorThrottle } from "./error-throttle.js";
import { JOBS } from "./jobs/index.js";
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
  logger.info({ signal }, "apagando el worker: esperando los jobs en curso");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se fuerza la salida");
    process.exit(1);
  }, GRACEFUL_STOP_MS + 10_000);
  force.unref();
  try {
    // graceful: deja de tomar jobs nuevos y espera a los activos antes de cerrar el pool.
    await boss.stop({ graceful: true, timeout: GRACEFUL_STOP_MS });
    logger.info("worker detenido");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error al detener pg-boss");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await boss.start();
  // Una señal durante el arranque: `shutdown` ya está deteniendo pg-boss; no se registra nada más.
  const registered =
    !shuttingDown && (await registerJobs(boss, JOBS, logger, { isStopping: () => shuttingDown }));
  if (registered) {
    logger.info({ jobs: JOBS.map((job) => job.name) }, "worker listo");
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
