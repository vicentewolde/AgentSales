import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import { createDb, pingDatabase } from "@agentsales/db";
import { createR2Storage } from "@agentsales/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { localAccess } from "./security.js";
import { readApiVersion } from "./version.js";

/** Solo en local: la API no tiene autenticación hasta F7. */
const HOSTNAME = "127.0.0.1";
const HEALTHCHECK_PATH = "_healthcheck/ping";
/** Mayor que el tope de un check de `/health` (25 s), para dejar terminar lo que está en curso. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

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
  access: localAccess(env.API_PORT, env.WEB_PORT),
});

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: HOSTNAME }, (info) => {
  logger.info({ url: `http://${HOSTNAME}:${info.port}` }, "API escuchando");
  if (env.PUBLISH_MODE === "live") {
    logger.warn("PUBLISH_MODE=live: las publicaciones son reales");
  } else {
    logger.info("PUBLISH_MODE=dry-run: no se publica nada de verdad");
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error(
      `El puerto ${env.API_PORT} está ocupado: ¿otra API corriendo? Cambia API_PORT o ciérrala.`,
    );
  } else {
    logger.error({ err: error }, "el servidor HTTP falló");
  }
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "apagando la API");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se cierran las conexiones y se fuerza la salida");
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  // `close` deja de aceptar conexiones y espera a las activas; las ociosas las cierra Node.
  server.close((error) => {
    if (error) {
      logger.warn({ err: error }, "el servidor ya estaba cerrado");
    }
    database
      .close()
      .catch((closeError: unknown) => logger.error({ err: closeError }, "error al cerrar la base"))
      .finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
