import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createErrorThrottle,
  createLogger,
  createMetaUserIdHasher,
  createPasswordHasher,
  createSecretBox,
  createSecretTokens,
  createSignedRequestVerifier,
  createStateSigner,
  createTotpProvider,
  findWorkspaceRoot,
  KEY_PURPOSES,
  loadAppEnvFile,
  loadEnv,
  marketplaceAutomationEnabled,
  panelUrlOf,
  resolveBackupDir,
  withoutBackupCredentials,
} from "@agentsales/config";
import { ALL_SCOPE, brokersNeedingApiKey, WORKER_HEARTBEAT_LOOKBACK } from "@agentsales/core";
import {
  createBrokerRepository,
  createContentRepository,
  createContentRunRepository,
  createDb,
  createEditorialProfileRepository,
  createFieldDefinitionRepository,
  createImportRunRepository,
  createInvitationRepository,
  createListingLock,
  createListingRepository,
  createLoginChallengeRepository,
  createMediaRepository,
  createMetaDeletionRepository,
  createOAuthStateRepository,
  createPlatformAccountRepository,
  createPlatformCatalogRepository,
  createPostLock,
  createPostRepository,
  createPublicationRepository,
  createSessionRepository,
  createUserRepository,
  createWorkerHeartbeatRepository,
  readServerVersion,
  toPgConnectionString,
} from "@agentsales/db";
import { BROKER_TEMPLATE_PATH, writeBrokerTemplate } from "@agentsales/importers";
// La subruta: sharp solo para el logo, sin ffmpeg ni el navegador del resto del paquete.
import { createLogoNormalizer } from "@agentsales/media/logo";
import {
  createInstagramAuth,
  createMercadoLibreAuth,
  createMercadoLibreItems,
  MERCADOLIBRE_API_TIMEOUT_MS,
} from "@agentsales/publishers";
// La subruta de Discord (F9-T14): solo el cliente del webhook, para conectarlo sin publicar.
import { createDiscordWebhooks } from "@agentsales/publishers/discord";
import { checkQueueSchema, createJobQueue } from "@agentsales/queue";
import { createR2Storage, r2BucketOrigin } from "@agentsales/storage";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { API_PREFIX } from "./access.js";
import { createApp } from "./app.js";
import { backupStatusReader } from "./backup-status.js";
import { createApiOperations } from "./portal.js";
import { clientIpResolver, createRateLimiter } from "./rate-limit.js";
import { createRequestContext } from "./request-context-node.js";
import { instagramStartUrlOf } from "./routes/oauth.js";
import { internetAccess, localAccess } from "./security.js";
import { createServerApp } from "./server-app.js";
import { readApiVersion } from "./version.js";

const HEALTHCHECK_PATH = "_healthcheck/ping";
/** Mayor que el tope de un check de `/health` (25 s), para dejar terminar lo que está en curso. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

// `ENV_FILE` es solo para los scripts (spec F8, D12): aquí se rechaza.
loadAppEnvFile();
// El token del bucket de respaldos es solo del worker (spec F8 §4.9, D13): la API lo quita de su
// configuración y de su entorno al arrancar (en Fly los secretos llegan a los dos procesos).
const env = withoutBackupCredentials(loadEnv());
// En internet (spec F8 §4.2): el host, el panel y los orígenes salen de `PUBLIC_URL`; sin ella, el Mac.
const publicUrl = env.PUBLIC_URL;
const https = publicUrl?.startsWith("https://") ?? false;
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

// La API solo encola (ADR-0005): pg-boss arranca en el primer `enqueue`, así la API levanta aunque
// el esquema `pgboss` no exista. Sus errores de fondo se resumen, como en el worker.
const queueErrors = createErrorThrottle(logger, "error de la cola (pg-boss)");
const queue = createJobQueue({
  connectionString: toPgConnectionString(env.DATABASE_URL),
  onError: (error) => queueErrors.report(error),
});
// Un solo `SecretBox` para toda la API: el candado y (desde T13) el repositorio de cuentas cifran y
// descifran con la clave derivada de APP_ENCRYPTION_KEY (F3-T02).
const secretBox = createSecretBox(env.APP_ENCRYPTION_KEY);

// `/health` (F6-T14): la versión de Postgres que lee el check de la base (también es el ping) y el
// estado del último respaldo: en su carpeta (fuera del proyecto; la API solo lee el archivo de estado)
// o, con el respaldo en R2 (F8-T13), en `system/` del bucket principal.
let serverVersion: string | null = null;
const brokers = createBrokerRepository(database.db);
const users = createUserRepository(database.db);
const workerHeartbeats = createWorkerHeartbeatRepository(database.db);
const backupStatus = backupStatusReader(
  env.BACKUP_TARGET === "r2"
    ? { target: "r2", storage }
    : {
        target: "local",
        dir: resolveBackupDir(env.BACKUP_DIR, {
          homeDir: homedir(),
          workspaceRoot: findWorkspaceRoot(),
        }),
      },
);

const access =
  publicUrl === undefined ? localAccess(env.API_PORT, env.WEB_PORT) : internetAccess(publicUrl);
const app = createApp({
  // Usuarios y sesiones (F7, ADR-0021): `scrypt` y los tokens de config; la cookie `Secure` llega
  // con HTTPS en F8.
  auth: {
    users,
    sessions: createSessionRepository(database.db),
    invitations: createInvitationRepository(database.db),
    brokers,
    hasher: createPasswordHasher(),
    tokens: createSecretTokens(),
    // El doble factor (spec F8 §4.8): TOTP con `node:crypto` y la clave cifrada con su propio
    // propósito (no abre las credenciales de las cuentas).
    loginChallenges: createLoginChallengeRepository(database.db),
    totp: createTotpProvider(),
    totpBox: createSecretBox(env.APP_ENCRYPTION_KEY, KEY_PURPOSES.totp),
    // Con HTTPS, la cookie `__Host-` y `Secure` (spec F8 §4.3).
    secureCookie: https,
  },
  oauthStates: createOAuthStateRepository(database.db),
  requestContext: createRequestContext(),
  checks: {
    // Se guarda la última leída (no se borra antes): dos `/health` a la vez nunca la ven en `null`
    // por el otro; si la base no responde, el reporte la informa `null` igual (check en falla).
    db: async () => {
      serverVersion = await readServerVersion(database.db);
    },
    // `head` devuelve null si el objeto no existe: basta con que no lance.
    storage: async () => {
      await storage.head(HEALTHCHECK_PATH);
    },
    // Solo lee el catálogo, sin pg-boss: `ok` es que la cola se inicializó alguna vez.
    queue: () => checkQueueSchema(database.db),
  },
  listings: createListingRepository(database.db),
  brokers,
  media: createMediaRepository(database.db),
  fieldDefinitions: createFieldDefinitionRepository(database.db),
  storage,
  // El logo y la planilla de un corredor (F7-T14).
  logos: createLogoNormalizer(),
  sha256Bytes: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  brokerTemplate: (broker) =>
    writeBrokerTemplate(join(findWorkspaceRoot(), BROKER_TEMPLATE_PATH), broker),
  importRuns: createImportRunRepository(database.db),
  contentRuns: createContentRunRepository(database.db),
  contents: createContentRepository(database.db),
  lock: createListingLock(database.db, { secretBox }),
  posts: createPostRepository(database.db),
  postLock: createPostLock(database.db, { secretBox }),
  editorialProfiles: createEditorialProfileRepository(database.db),
  publications: createPublicationRepository(database.db),
  platformAccounts: createPlatformAccountRepository(database.db, { secretBox }),
  instagram: {
    // Sin el par de la app, `/me` (conectar con el token del panel) funciona igual; solo el canje
    // del OAuth lo necesita, y `/oauth/instagram/start` vuelve al panel con INSTAGRAM_NOT_CONFIGURED.
    auth: createInstagramAuth({
      appId: env.INSTAGRAM_APP_ID ?? "",
      appSecret: env.INSTAGRAM_APP_SECRET ?? "",
      redirectUri: env.INSTAGRAM_REDIRECT_URI,
    }),
    oauthConfigured: Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
    secureCookie: env.INSTAGRAM_REDIRECT_URI.startsWith("https://"),
  },
  // Conectar un webhook lo lee en Discord sin publicar (tope de 10 s: el operador espera).
  discord: createDiscordWebhooks({ timeoutMs: 10_000 }),
  mercadoLibre: {
    // Sin el par de la app, conectar responde MERCADOLIBRE_NOT_CONFIGURED sin llamar (el canje
    // mandaría un secret vacío). Tope de 10 s: el operador espera la respuesta (spec F4 §4.3).
    auth: createMercadoLibreAuth({
      appId: env.ML_APP_ID ?? "",
      clientSecret: env.ML_CLIENT_SECRET ?? "",
      redirectUri: env.ML_REDIRECT_URI,
      timeoutMs: MERCADOLIBRE_API_TIMEOUT_MS,
    }),
    configured: Boolean(env.ML_APP_ID && env.ML_CLIENT_SECRET),
    redirectUri: env.ML_REDIRECT_URI,
    // Con el dominio (HTTPS) la vuelta es automática, con la cookie `__Host-` (spec F8 §4.3, T19).
    secureCookie: https,
  },
  // Pausar, reactivar, cerrar y el sync de Portal (F4-T19) y actualizar (F6-T07, con el catálogo
  // guardado en la base): 10 s por llamada, sin envolver.
  operationsFor: createApiOperations(
    createMercadoLibreItems,
    createPlatformCatalogRepository(database.db),
  ),
  oauthState: createStateSigner(env.APP_ENCRYPTION_KEY),
  // Las vueltas de Meta (spec F8 §4.11): la firma con la clave de la app de Instagram o la de la
  // app de Meta (cuál firma no está verificado); sin ninguna, toda vuelta responde 400.
  verifyMetaSignature: createSignedRequestVerifier([
    env.INSTAGRAM_APP_SECRET,
    env.FACEBOOK_APP_SECRET,
  ]),
  hashMetaUserId: createMetaUserIdHasher(env.APP_ENCRYPTION_KEY),
  metaDeletion: createMetaDeletionRepository(database.db),
  // El host del panel debe ser el mismo de la URI de retorno (la cookie distingue `localhost`).
  panelUrl: panelUrlOf(env),
  instagramStartUrl: instagramStartUrlOf(env.INSTAGRAM_REDIRECT_URI),
  queue,
  // Las cargas suben directo a R2 (spec F8 §4.4, ADR-0025): la API solo firma y revisa.
  newId: randomUUID,
  maxUploadBytes: env.MAX_IMPORT_UPLOAD_MB * 1024 * 1024,
  maxVideoBytes: env.MAX_VIDEO_MB * 1024 * 1024,
  publishMode: env.PUBLISH_MODE,
  environment: env.NODE_ENV === "production" ? "production" : "development",
  // Marketplace (spec F5 §4.6 y §4.7): el límite diario y si se puede convertir la UF.
  marketplace: {
    dailyLimit: env.MARKETPLACE_DAILY_LIMIT,
    ufConfigured: env.BCCH_API_TOKEN !== undefined,
  },
  // En producción, Marketplace se publica a mano: el formulario automático no corre (F8-T20, D4).
  marketplaceAutomation: marketplaceAutomationEnabled(env),
  version: readApiVersion(),
  healthDetails: {
    serverVersion: () => serverVersion,
    backupStatus,
    // Con `pnpm dev` la API y el worker reciben el mismo `PUBLISH_MODE` (spec F6 §4.10).
    autoPublishBrokers: async () =>
      (await brokers.list(ALL_SCOPE))
        .filter((broker) => broker.autoPublish)
        .map((broker) => broker.slug),
    // Los corredores no propios usan la API de Anthropic (spec F7 §4.7): sin la clave, sus textos
    // fallarán en el worker (que lee el mismo `.env` con `pnpm dev`).
    llmKeyMissingBrokers: async () =>
      brokersNeedingApiKey(await brokers.list(ALL_SCOPE), {
        provider: env.LLM_PROVIDER,
        hasApiKey: (env.ANTHROPIC_API_KEY ?? "") !== "",
      }),
    // Los administradores sin el doble factor (F8-T15): `doctor` recomienda activarlo.
    adminsWithoutTotp: async () =>
      (await users.list())
        .filter((u) => u.role === "admin" && u.disabledAt === null && u.totpEnabledAt === null)
        .map((u) => u.email),
    // El latido del worker (F8-T12): si está encendido y desde cuándo.
    workerHeartbeats: () => workerHeartbeats.listLatest(WORKER_HEARTBEAT_LOOKBACK),
  },
  logger,
  access,
  // Límites por IP y por usuario (spec F8 §4.8): la IP de `CLIENT_IP_HEADER` (en Fly,
  // `Fly-Client-IP`) o la del socket; nunca `X-Forwarded-For` sin configurarla.
  rateLimit: {
    limiter: createRateLimiter(),
    clientIp: clientIpResolver(env.CLIENT_IP_HEADER, (c) => getConnInfo(c).remote.address),
  },
});

// La API bajo `/api` en los dos modos y, en producción, el panel compilado del mismo origen.
const serverApp = createServerApp(app, {
  ...(env.NODE_ENV === "production"
    ? { panelDir: join(findWorkspaceRoot(), "apps/web/dist") }
    : {}),
  storageOrigin: r2BucketOrigin({ accountId: env.R2_ACCOUNT_ID, bucket: env.R2_BUCKET }),
  https,
  allowedHosts: access.allowedHosts,
});

const server = serve(
  { fetch: serverApp.fetch, port: env.API_PORT, hostname: env.API_HOST },
  (info) => {
    logger.info({ url: `http://${env.API_HOST}:${info.port}${API_PREFIX}` }, "API escuchando");
    if (env.PUBLISH_MODE === "live") {
      logger.warn("PUBLISH_MODE=live: las publicaciones son reales");
    } else {
      logger.info("PUBLISH_MODE=dry-run: no se publica nada de verdad");
    }
  },
);

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
    queueErrors.dispose();
    Promise.all([queue.stop(), database.close()])
      .catch((closeError: unknown) =>
        logger.error({ err: closeError }, "error al cerrar la cola o la base"),
      )
      .finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
