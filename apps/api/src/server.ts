import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import { createDb, pingDatabase } from "@agentsales/db";
import { createR2Storage } from "@agentsales/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readApiVersion } from "./version.js";

/** Solo en local: la API no tiene autenticación hasta F7. */
const HOSTNAME = "127.0.0.1";
const HEALTHCHECK_PATH = "_healthcheck/ping";
const SHUTDOWN_TIMEOUT_MS = 10_000;

loadEnvFile();
const env = loadEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
  name: "api",
});

const database = createDb(env.DATABASE_URL, {
  onError: (error) => logger.warn({ err: error }, "conexión inactiva cerrada por la base de datos"),
});
const storage = createR2Storage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
});

const app = createApp({
  checks: {
    db: () => pingDatabase(database.db),
    // `head` devuelve null si el objeto no existe: basta con que no lance.
    storage: async () => {
      await storage.head(HEALTHCHECK_PATH);
    },
    queue: async () => {
      throw new AppError("QUEUE_NOT_IMPLEMENTED", "pendiente: F0-T06");
    },
  },
  publishMode: env.PUBLISH_MODE,
  version: readApiVersion(),
  logger,
});

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: HOSTNAME }, (info) => {
  logger.info({ url: `http://${HOSTNAME}:${info.port}` }, "API escuchando");
  if (env.PUBLISH_MODE === "live") {
    logger.warn("PUBLISH_MODE=live: las publicaciones son reales");
  } else {
    logger.info("PUBLISH_MODE=dry-run: no se publica nada de verdad");
  }
});

function shutdown(signal: string): void {
  logger.info({ signal }, "apagando la API");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se fuerza la salida");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
