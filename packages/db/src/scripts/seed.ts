import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { count } from "drizzle-orm";
import { createDb } from "../client.js";
import { brokers } from "../schema.js";
import { seed } from "../seed.js";

loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });
const { db, close } = createDb(env.DATABASE_URL);

try {
  const { brokerId } = await seed(db);
  const [total] = await db.select({ value: count() }).from(brokers);
  logger.info({ brokerId, brokers: total?.value }, "seed aplicado");
} catch (error) {
  logger.error({ err: error }, "falló el seed");
  process.exitCode = 1;
} finally {
  await close();
}
