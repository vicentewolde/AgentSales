import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { SYSTEM_PING, systemPingSchema } from "../jobs/system-ping.js";
import { createBoss } from "../queue.js";

// Encola un `system.ping` para probar el worker: `pnpm worker:ping [delayMs]`.
// No crea la cola: la crea el worker con su política (jobs/define.ts).
loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });

const parsed = systemPingSchema.safeParse({
  message: "ping desde el script de prueba",
  delayMs: Number(process.argv[2] ?? 0),
});
if (!parsed.success) {
  logger.error("delayMs debe ser un entero entre 0 y 10000");
  process.exit(1);
}

const boss = createBoss(env.DATABASE_URL, "producer");
boss.on("error", (error) => logger.error({ err: error }, "error de pg-boss"));

try {
  await boss.start();
  const jobId = await boss.send(SYSTEM_PING, parsed.data);
  logger.info({ jobId, data: parsed.data }, "system.ping encolado");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const notReady = /not installed|requires migrations|does not exist/i.test(message);
  logger.error(
    { err: error },
    notReady
      ? "la cola no está lista: arranca el worker una vez (pnpm dev) y vuelve a intentar"
      : "no se pudo encolar system.ping",
  );
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false }).catch(() => undefined);
}
