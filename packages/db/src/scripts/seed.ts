import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { count } from "drizzle-orm";
import { createDb } from "../client.js";
import { brokers } from "../schema.js";
import { seed } from "../seed.js";

loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });
const { db, close } = createDb(env.DATABASE_URL, {
  onError: (error) => logger.warn({ err: error }, "conexión inactiva cerrada por la base de datos"),
});

try {
  const result = await seed(db);
  const [total] = await db.select({ value: count() }).from(brokers);
  logger.info({ ...result, brokers: total?.value }, "seed aplicado");
} catch (error) {
  logger.error({ err: error }, "falló el seed");
  process.exitCode = 1;
} finally {
  await close();
}
