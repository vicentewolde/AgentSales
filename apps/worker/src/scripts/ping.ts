import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { isAppError, JOB_PAYLOADS } from "@agentsales/core";
import { toPgConnectionString } from "@agentsales/db";
import { createJobQueue } from "@agentsales/queue";

// Encola un `system.ping` para probar el worker: `pnpm worker:ping [delayMs]`.
// Usa el productor de `@agentsales/queue`, como la API. No crea la cola: la crea el worker con su
// política (jobs/define.ts).
loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });

const parsed = JOB_PAYLOADS["system.ping"].safeParse({
  message: "ping desde el script de prueba",
  delayMs: Number(process.argv[2] ?? 0),
});
if (!parsed.success) {
  logger.error("delayMs debe ser un entero entre 0 y 10000");
  process.exit(1);
}

const queue = createJobQueue({
  connectionString: toPgConnectionString(env.DATABASE_URL),
  onError: (error) => logger.error({ err: error }, "error de pg-boss"),
});

try {
  const jobId = await queue.enqueue("system.ping", parsed.data);
  logger.info({ jobId, data: parsed.data }, "system.ping encolado");
} catch (error) {
  logger.error(
    { err: error },
    isAppError(error) ? `${error.code}: ${error.message}` : "no se pudo encolar system.ping",
  );
  process.exitCode = 1;
} finally {
  await queue.stop();
}
