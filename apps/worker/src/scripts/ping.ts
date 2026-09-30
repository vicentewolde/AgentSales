import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { SYSTEM_PING, type SystemPingData } from "../jobs/system-ping.js";
import { createBoss } from "../queue.js";

// Encola un `system.ping` para probar el worker: `pnpm worker:ping [delayMs]`.
loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });

const delayMs = Number(process.argv[2] ?? 0);
const data: SystemPingData = {
  message: "ping desde el script de prueba",
  delayMs: Number.isFinite(delayMs) ? delayMs : 0,
};

const boss = createBoss(env.DATABASE_URL, "producer");
boss.on("error", (error) => logger.error({ err: error }, "error de pg-boss"));

try {
  await boss.start();
  await boss.createQueue(SYSTEM_PING);
  const jobId = await boss.send(SYSTEM_PING, data);
  logger.info({ jobId, data }, "system.ping encolado");
} catch (error) {
  logger.error({ err: error }, "no se pudo encolar system.ping");
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false });
}
