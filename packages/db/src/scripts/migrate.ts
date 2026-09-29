import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../client.js";
import { MIGRATIONS_FOLDER } from "../migrations.js";

loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });
const { db, close } = createDb(env.DATABASE_URL, {
  onError: (error) => logger.warn({ err: error }, "conexión inactiva cerrada por la base de datos"),
});

try {
  logger.info({ folder: MIGRATIONS_FOLDER }, "aplicando migraciones");
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logger.info("migraciones al día");
} catch (error) {
  logger.error({ err: error }, "falló la migración");
  process.exitCode = 1;
} finally {
  await close();
}
