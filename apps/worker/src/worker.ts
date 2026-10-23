import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  backupStorageOf,
  createErrorThrottle,
  createLogger,
  createSecretBox,
  findWorkspaceRoot,
  loadAppEnvFile,
  loadEnv,
  marketplaceAutomationEnabled,
  resolveBackupDir,
  resolveBrowserProfilesDir,
} from "@agentsales/config";
import {
  type AutoPublishDeps,
  confirmManualPublication,
  enqueueLiveSyncs,
  isTerminalImportRun,
  type RunImportDeps,
} from "@agentsales/core";
import {
  createBrokerRepository,
  createContentRepository,
  createContentRunRepository,
  createDb,
  createEditorialProfileRepository,
  createFieldDefinitionRepository,
  createImportRunRepository,
  createListingLock,
  createListingRepository,
  createLoginChallengeRepository,
  createMediaRepository,
  createOAuthStateRepository,
  createPlanRunRepository,
  createPlatformAccountRepository,
  createPlatformCatalogRepository,
  createPostImageRunRepository,
  createPostLock,
  createPostRepository,
  createPostUploadRepository,
  createPublicationRepository,
  createSessionRepository,
  createWorkerHeartbeatRepository,
  toPgConnectionString,
} from "@agentsales/db";
import { createStaging, stagingRootOf } from "@agentsales/importers/staging";
import { createLlmProvider } from "@agentsales/llm";
import { createCardRenderer, createHtmlRenderer, createMediaProcessor } from "@agentsales/media";
import {
  createInstagramAuth,
  createInstagramPublisher,
  createMercadoLibreAuth,
  MERCADOLIBRE_REFRESH_TIMEOUT_MS,
} from "@agentsales/publishers";
import { createDiscordPublisher } from "@agentsales/publishers/discord";
import { createGeminiImages, createPixabayStock } from "@agentsales/publishers/images";
import { createLinkedInPublisher } from "@agentsales/publishers/linkedin";
import { marketplaceProfileDir, openMarketplaceProfile } from "@agentsales/publishers/marketplace";
import { createTikTokAuth, createTikTokPublisher } from "@agentsales/publishers/tiktok";
import { createBancoCentralUf } from "@agentsales/publishers/uf";
import { createXAuth, createXPublisher } from "@agentsales/publishers/x";
import { createBoss, jobQueueFromBoss } from "@agentsales/queue";
import { createR2Storage } from "@agentsales/storage";
import { createSlideTemplates } from "@agentsales/templates";
import {
  cleanContentTmp,
  contentTmpRootOf,
  MARKETPLACE_EVIDENCE_MAX_AGE_MS,
  marketplaceTmpRootOf,
} from "./content-tmp.js";
import { type Heartbeat, startHeartbeat, workerProcessId } from "./heartbeat.js";
import { createIdleProbe, type IdleExit, pendingJobsOf, startIdleExit } from "./idle-exit.js";
import { failAbandonedPlanRuns, requeueQueuedPlanRuns } from "./jobs/content-plan.js";
import {
  failAbandonedContentRuns,
  requeueQueuedContentRuns,
  requeueQueuedPostRuns,
  resumeAutoPublishAtStart,
} from "./jobs/content-prepare.js";
import { type BackupTarget, backupStatusOf, requestBackupIfDue } from "./jobs/db-backup.js";
import { IMPORT_ABANDONED, IMPORT_RUN_ABANDONED_AFTER_MS } from "./jobs/import-run.js";
import { buildJobs } from "./jobs/index.js";
import { failAbandonedPostImageRuns, requeueQueuedPostImageRuns } from "./jobs/post-image.js";
import { enqueuePublicationDue } from "./jobs/publication-due.js";
import { instagramNoteLogger, requeuePublishingPublications } from "./jobs/publication-publish.js";
import { registerJobs } from "./jobs/registry.js";
import { enqueueTokensRefresh } from "./jobs/tokens-refresh.js";
import {
  apiLlmOptions,
  llmProviderOptions,
  planLlmProviderOptions,
  socialLlmProviderOptions,
} from "./llm-options.js";
import { createWorkerMarketplacePublisher } from "./marketplace/publisher.js";
import { createMarketplaceWindows, sweepClosedWindows } from "./marketplace/windows.js";
import { createWorkerPortal } from "./portal.js";
import { type ShutdownReason, stopOptionsFor, stopWorker } from "./shutdown.js";

// `ENV_FILE` es solo para los scripts (spec F8, D12): aquí se rechaza.
loadAppEnvFile();
const env = loadEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
  name: "worker",
});

// Dependencias de los jobs: se componen aquí, en el punto de entrada (01-arquitectura.md).
const dbErrors = createErrorThrottle(logger, "error de la base de datos");
const database = createDb(env.DATABASE_URL, { onError: (error) => dbErrors.report(error) });
const importRuns = createImportRunRepository(database.db);
const contentRuns = createContentRunRepository(database.db);
// `pnpm --filter` corre cada app en su carpeta: los temporales se resuelven contra la raíz.
const workspaceRoot = findWorkspaceRoot();
const contentTmpRoot = contentTmpRootOf(workspaceRoot);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** sha256 hexadecimal de un archivo de R2 leído en streaming (F9-T17: sin cargarlo en memoria). */
async function sha256OfStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
const repositories = {
  brokers: createBrokerRepository(database.db),
  listings: createListingRepository(database.db),
  fieldDefinitions: createFieldDefinitionRepository(database.db),
  media: createMediaRepository(database.db),
};
const storage = createR2Storage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
});
// Las cargas (spec F8 §4.4, ADR-0025): el worker baja de R2 la planilla y los medios a su carpeta
// temporal, y al terminar borra lo de la carga en R2 y en el disco.
const staging = createStaging({
  root: stagingRootOf(workspaceRoot),
  storage,
  maxVideoBytes: env.MAX_VIDEO_MB * 1024 * 1024,
});
const importRun: RunImportDeps = {
  ...repositories,
  importRuns,
  storage,
  sha256: async (text) => sha256(text),
  readSheet: (request) => staging.readSheet(request),
  openMedia: (request) => staging.openMedia(request),
  discardInput: (runId) => staging.discard(runId),
};
// Un Chromium por proceso (spec F2 §4.2): se abre al primer render y se cierra al apagar, después
// de que pg-boss detuvo los handlers (`stopWorker`).
const renderer = createHtmlRenderer();
// Se dispara al apagar: los handlers cortan ffmpeg, Chromium y la CLI de Claude (que corre en su
// propio grupo de procesos y no recibe el Ctrl+C de la terminal).
const jobsAbort = new AbortController();
// Publicar (spec F3 §4.4): las credenciales se descifran con la clave de APP_ENCRYPTION_KEY.
const publications = createPublicationRepository(database.db);
const secretBox = createSecretBox(env.APP_ENCRYPTION_KEY);
const platformAccounts = createPlatformAccountRepository(database.db, { secretBox });
// Registrado en los dos modos: una publicación en `dry_run` también lo necesita (lo envuelve
// `withDryRun`). El cliente de Instagram se arma recién al primer intento en `live` (perezoso).
const instagram = createInstagramPublisher({ onNote: instagramNoteLogger(logger) });
// Discord por webhook (F9-T14): sin cliente que armar ni secreto propio (la URL es la credencial
// de cada cuenta). Sus notas van al log solo con ids y cifras, nunca con la URL.
const discord = createDiscordPublisher({
  onNote: (note) => logger.info(note, "nota del publicador de Discord"),
});
// X (F9-T16): el publisher en los dos modos (en `dry-run` lo envuelve `withDryRun` y no llama).
// Sus notas van al log solo con ids y cifras, nunca con un token.
const x = createXPublisher({ onNote: (note) => logger.info(note, "nota del publicador de X") });
// TikTok (F9-T26): el video como borrador en la bandeja (modo Upload); registrado en los dos modos
// (en `dry-run` lo envuelve `withDryRun` y no llama a TikTok). Sus notas, solo con ids y cifras.
const tiktok = createTikTokPublisher({
  onNote: (note) => logger.info(note, "nota del publicador de TikTok"),
});
// La renovación de los tokens que rotan (X cada 2 h, TikTok cada 24 h; ADR-0029 punto 11), al
// publicar y en `tokens.refresh`, con la misma función (`ensureRotatingAccessToken`). Sin el par de
// la app de una red no se arma su renovación, y una cuenta suya por renovar es
// `TOKEN_REFRESH_NOT_CONFIGURED` sin cambiarla.
const tokenRefreshers = {
  ...(env.X_CLIENT_ID && env.X_CLIENT_SECRET
    ? {
        x: createXAuth({
          clientId: env.X_CLIENT_ID,
          clientSecret: env.X_CLIENT_SECRET,
          redirectUri: env.X_REDIRECT_URI,
        }),
      }
    : {}),
  ...(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET
    ? {
        tiktok: createTikTokAuth({
          clientKey: env.TIKTOK_CLIENT_KEY,
          clientSecret: env.TIKTOK_CLIENT_SECRET,
          redirectUri: env.TIKTOK_REDIRECT_URI,
        }),
      }
    : {}),
};
// LinkedIn, perfil personal (F9-T15): solo llega aquí una cuenta en modo `api`; en `manual` (el de
// por defecto, D5) core deja el texto listo sin llamar a la red. Sus notas van al log solo con ids
// y cifras, nunca con el token ni una URL.
const linkedin = createLinkedInPublisher({
  onNote: (note) => logger.info(note, "nota del publicador de LinkedIn"),
});
// Refresco de tokens (spec F3 §4.6): solo usa el token, así que funciona sin el par de la app
// (como en la API); el par lo necesita solo el canje del OAuth, que el worker no hace.
const instagramAuth = createInstagramAuth({
  appId: env.INSTAGRAM_APP_ID ?? "",
  appSecret: env.INSTAGRAM_APP_SECRET ?? "",
  redirectUri: env.INSTAGRAM_REDIRECT_URI,
});
// Mercado Libre exige el par de la app también para refrescar (spec F4 §4.3): sin él, `null`, y el
// lote salta las cuentas de Portal sin cambiarlas. El refresco tiene su propio tope de 10 s.
const mercadoLibreAuth =
  env.ML_APP_ID && env.ML_CLIENT_SECRET
    ? createMercadoLibreAuth({
        appId: env.ML_APP_ID,
        clientSecret: env.ML_CLIENT_SECRET,
        redirectUri: env.ML_REDIRECT_URI,
        timeoutMs: MERCADOLIBRE_REFRESH_TIMEOUT_MS,
      })
    : null;
// Portal (spec F4 §4.8 y T18): el publisher en los dos modos (como Instagram) y las operaciones sin
// envolver para el sync, que solo lee. El catálogo se guarda en la base; las fotos salen de R2.
// Marketplace (spec F5, ADR-0017): los perfiles del navegador viven fuera del proyecto; la carpeta
// se resuelve aquí, en un solo lugar (`resolveBrowserProfilesDir` rechaza una dentro del proyecto).
const profilesRoot = resolveBrowserProfilesDir(env.BROWSER_PROFILES_DIR, {
  homeDir: homedir(),
  workspaceRoot,
});
// En producción el formulario automático no corre (spec F8 §4.10, D4): sin publisher de
// Marketplace, sin el job `marketplace.profile` y sin evidencia que limpiar. Una cuenta
// a mano no necesita nada de esto (el traspaso es de core). Core recibe lo que el ambiente permite.
const marketplaceAutomation = marketplaceAutomationEnabled(env);
// El respaldo (spec F6 §4.11 y F8 §4.9): en el Mac, la carpeta, también fuera del proyecto (trae
// datos de clientes); con `BACKUP_TARGET=r2` (producción), el bucket de respaldos con su propio
// token, que solo tiene el worker, y el estado en `system/` del bucket principal.
const backupStorage = backupStorageOf(env);
if (env.BACKUP_TARGET === "r2" && backupStorage === null) {
  // `loadEnv` ya lo exige; si eso cambiara, el worker no vuelve en silencio al disco local.
  throw new Error("BACKUP_TARGET=r2 sin el bucket o el token de respaldos (BACKUP_R2_*)");
}
const backupTarget: BackupTarget =
  backupStorage === null
    ? {
        kind: "local",
        dir: resolveBackupDir(env.BACKUP_DIR, { homeDir: homedir(), workspaceRoot }),
      }
    : {
        kind: "r2",
        backups: createR2Storage({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: backupStorage.accessKeyId,
          secretAccessKey: backupStorage.secretAccessKey,
          bucket: backupStorage.bucket,
          signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
        }),
        status: storage,
      };
const listingLock = createListingLock(database.db, { secretBox });
// Los posts (spec F9 §4.5): sus medios y la limpieza de sus subidas, con el candado del post.
const posts = createPostRepository(database.db);
const postLock = createPostLock(database.db, { secretBox });
// Los planes de ideas (spec F9 §4.9): sus ideas se guardan como posts en la misma transacción.
const planRuns = createPlanRunRepository(database.db);
// Los pedidos de imágenes de los posts (F9.5-T25): el job y el arranque (abandonados y en cola).
const postImageRuns = createPostImageRunRepository(database.db);
const marketplaceWindows = createMarketplaceWindows({
  publications,
  confirm: (publicationId, url) =>
    confirmManualPublication(
      { lock: listingLock, publications },
      { publicationId, url, actor: "system" },
    ),
  timeoutMs: env.MARKETPLACE_CONFIRM_TIMEOUT_MIN * 60_000,
  logger,
});
// El valor de la UF para el precio de Marketplace (spec F5 §4.6): sin el token, `null` (un aviso
// en UF no llega aquí: `MARKETPLACE_NOT_READY` lo frena antes).
const ufSource =
  env.BCCH_API_TOKEN === undefined ? null : createBancoCentralUf({ token: env.BCCH_API_TOKEN });
const portal = createWorkerPortal({
  catalogRepository: createPlatformCatalogRepository(database.db),
  storage,
  logger,
});
// `auto_publish` (spec F6 §4.10): con el modo del worker, el único camino en que lo fija. Lo usan
// el job `content.prepare` y el arranque (retomar uno cortado, F8-T12).
const autoPublish: AutoPublishDeps = {
  lock: listingLock,
  // Se arma más abajo (`jobQueueFromBoss`); los handlers corren después de arrancar.
  queue: { enqueue: (name, data, options) => queue.enqueue(name, data, options) },
  listings: repositories.listings,
  fieldDefinitions: repositories.fieldDefinitions,
  brokers: repositories.brokers,
  contents: createContentRepository(database.db),
  platformAccounts,
  marketplace: {
    dailyLimit: env.MARKETPLACE_DAILY_LIMIT,
    ufConfigured: env.BCCH_API_TOKEN !== undefined,
    automation: marketplaceAutomation,
  },
  dryRun: env.PUBLISH_MODE !== "live",
};
// La API de Anthropic para los corredores y marcas que no son del operador (spec F7 §4.7).
const apiLlm = ((options) => (options === null ? null : createLlmProvider(options)))(
  apiLlmOptions(env),
);
const jobs = buildJobs({
  importRun,
  contentPrepare: {
    shared: {
      ...repositories,
      contentRuns,
      storage,
      templates: createSlideTemplates(),
      renderer,
      // El del operador para sus corredores propios, y la API para los demás (spec F7 §4.7).
      llm: createLlmProvider(llmProviderOptions(env, process.env)),
      apiLlm,
      sha256,
    },
    // Sin `threads`: ffmpeg usa todos los núcleos (los tests limitan a 2).
    createProcessor: (workDir) =>
      createMediaProcessor({
        ffmpegPath: env.FFMPEG_PATH,
        ffprobePath: env.FFPROBE_PATH,
        workDir,
      }),
    tmpRoot: contentTmpRoot,
    signal: jobsAbort.signal,
    autoPublish,
  },
  publicationPublish: {
    shared: {
      publications,
      platformAccounts,
      contents: createContentRepository(database.db),
      media: repositories.media,
      listings: repositories.listings,
      brokers: repositories.brokers,
      storage,
      publishers: {
        instagram,
        discord,
        x,
        linkedin,
        tiktok,
        portal_inmobiliario: portal.publisher,
        // En `live` llena el formulario y deja la ventana al registro; en `dry-run` no abre nada.
        // En producción no se registra (D4): publicar con una cuenta de perfil ya falló en core.
        ...(marketplaceAutomation
          ? {
              fb_marketplace: createWorkerMarketplacePublisher({
                openProfile: (brokerId) =>
                  openMarketplaceProfile({ dir: marketplaceProfileDir(profilesRoot, brokerId) }),
                storage,
                tmpRoot: marketplaceTmpRootOf(workspaceRoot),
                windows: marketplaceWindows,
              }),
            }
          : {}),
      },
      workerMode: env.PUBLISH_MODE,
      marketplaceDailyLimit: env.MARKETPLACE_DAILY_LIMIT,
      marketplaceAutomation,
      uf: ufSource,
      // El token de Portal se asegura (y se refresca) con el par de la app (spec F4 §4.3).
      mercadoLibre: mercadoLibreAuth,
      // X y TikTok (F9-T16, T26): la renovación de su token; X, además, la marca del enlace de cada post.
      tokenRefreshers,
      posts,
    },
    // Se arma más abajo (`jobQueueFromBoss`); los handlers corren después de arrancar.
    queue: { enqueue: (name, data, options) => queue.enqueue(name, data, options) },
    signal: jobsAbort.signal,
    marketplaceWindows,
  },
  publicationSync: {
    shared: {
      lock: listingLock,
      publications,
      platformAccounts,
      mercadoLibre: mercadoLibreAuth,
      operationsFor: portal.operationsFor,
    },
    signal: jobsAbort.signal,
  },
  tokensRefresh: {
    platformAccounts,
    instagram: instagramAuth,
    mercadoLibre: mercadoLibreAuth,
    refreshers: tokenRefreshers,
    signal: jobsAbort.signal,
  },
  marketplaceProfile: marketplaceAutomation
    ? {
        profilesRoot,
        openProfile: (brokerId) =>
          openMarketplaceProfile({ dir: marketplaceProfileDir(profilesRoot, brokerId) }),
        windows: marketplaceWindows,
        brokers: repositories.brokers,
        platformAccounts,
        publications,
        marketplaceAutomation,
        signal: jobsAbort.signal,
      }
    : null,
  publicationDue: {
    lock: listingLock,
    // Las programadas de posts (F9-T07) se empiezan en el candado del post.
    postLock,
    // Se arma más abajo (`jobQueueFromBoss`); los handlers corren después de arrancar.
    queue: { enqueue: (name, data, options) => queue.enqueue(name, data, options) },
    publications,
    listings: repositories.listings,
    fieldDefinitions: repositories.fieldDefinitions,
  },
  publicationsWatch: {
    publications,
    platformAccounts,
    authCleanup: {
      sessions: createSessionRepository(database.db),
      oauthStates: createOAuthStateRepository(database.db),
      loginChallenges: createLoginChallengeRepository(database.db),
    },
    // Las subidas que nadie terminó y lo que quedó en R2 de cargas terminadas (spec F8 §4.4).
    importCleanup: { importRuns, storage },
    // Las subidas de medios de posts que nadie terminó en 24 h (spec F9 §4.5).
    postUploadCleanup: {
      postUploads: createPostUploadRepository(database.db),
      postLock,
      storage,
    },
    // Se arma más abajo (`jobQueueFromBoss`); los handlers corren después de arrancar.
    queue: { enqueue: (name, data, options) => queue.enqueue(name, data, options) },
  },
  postMedia: {
    shared: { posts, media: repositories.media, storage },
    // Las subidas grandes sin sha256 (F9-T17): se hashean en streaming y se deduplican.
    uploads: { posts, postLock, storage, sha256Stream: sha256OfStream },
    createProcessor: (workDir) =>
      createMediaProcessor({
        ffmpegPath: env.FFMPEG_PATH,
        ffprobePath: env.FFPROBE_PATH,
        workDir,
      }),
    tmpRoot: contentTmpRoot,
    signal: jobsAbort.signal,
  },
  // Los textos de un post (spec F9 §4.9, F9-T11): el perfil de su marca, sus cuentas y sus medios,
  // y el candado del post para guardar los textos y dejar su estado al día.
  postDraft: {
    shared: {
      contentRuns,
      posts,
      brokers: repositories.brokers,
      editorialProfiles: createEditorialProfileRepository(database.db),
      platformAccounts,
      media: repositories.media,
      postLock,
      // Con `fake`, el borrador de ejemplo de un post (no el de un aviso).
      llm: createLlmProvider(socialLlmProviderOptions(env, process.env)),
      apiLlm,
    },
    signal: jobsAbort.signal,
  },
  // El plan de ideas (spec F9 §4.9, F9-T20): el perfil de la marca, sus posts recientes (los temas
  // que no se repiten) y la IA; las ideas quedan como posts `idea`, sin textos ni publicaciones.
  contentPlan: {
    shared: {
      planRuns,
      posts,
      brokers: repositories.brokers,
      editorialProfiles: createEditorialProfileRepository(database.db),
      contentRuns,
      // Con `fake`, un plan de ejemplo armado con lo que pide el prompt.
      llm: createLlmProvider(planLlmProviderOptions(env, process.env)),
      apiLlm,
      newId: randomUUID,
    },
    signal: jobsAbort.signal,
  },
  // Conseguir imágenes para un post (F9.5-T25, ADR-0038): las tarjetas siempre; la biblioteca y
  // la IA solo con su clave. El modelo, el precio y el tope son de la configuración.
  postImage: {
    shared: {
      runs: postImageRuns,
      posts,
      brokers: repositories.brokers,
      contents: createContentRepository(database.db),
      media: repositories.media,
      storage,
      postLock,
      // Se arma más abajo (`jobQueueFromBoss`); los handlers corren después de arrancar.
      queue: { enqueue: (name, data, options) => queue.enqueue(name, data, options) },
      cards: createCardRenderer(),
      stock: env.PIXABAY_API_KEY ? createPixabayStock({ apiKey: env.PIXABAY_API_KEY }) : null,
      ai: env.GEMINI_API_KEY
        ? {
            generator: createGeminiImages({
              apiKey: env.GEMINI_API_KEY,
              model: env.IMAGE_AI_MODEL,
            }),
            model: env.IMAGE_AI_MODEL,
            pricing: {
              priceUsd: env.IMAGE_AI_PRICE_USD,
              monthlyCapUsd: env.IMAGE_AI_MONTHLY_CAP_USD,
            },
          }
        : null,
      sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    },
    createProcessor: (workDir) =>
      createMediaProcessor({
        ffmpegPath: env.FFMPEG_PATH,
        ffprobePath: env.FFPROBE_PATH,
        workDir,
      }),
    tmpRoot: contentTmpRoot,
    signal: jobsAbort.signal,
  },
  dbBackup: {
    target: backupTarget,
    databaseUrl: env.DATABASE_URL,
    ...(env.PG_BIN_DIR === undefined ? {} : { binDir: env.PG_BIN_DIR }),
    signal: jobsAbort.signal,
  },
});

const boss = createBoss({
  connectionString: toPgConnectionString(env.DATABASE_URL),
  role: "worker",
});
// Sin conexión, pg-boss reintenta cada 1–2 s y emite un error por intento: se resumen.
const bossErrors = createErrorThrottle(logger, "error de pg-boss");
boss.on("error", (error) => bossErrors.report(error));
boss.on("warning", (warning) => logger.warn({ warning }, "aviso de pg-boss"));
// Para reencolar al arrancar con la conexión del worker (no abre otra como `createJobQueue`).
const queue = jobQueueFromBoss(boss);

let shuttingDown = false;
/** Por qué se está apagando (`null` mientras corre). */
let shutdownReason: ShutdownReason | null = null;
/** El latido (F8-T12): empieza cuando los jobs quedan registrados. */
let heartbeat: Heartbeat | null = null;
/** El apagado solo sin trabajo (F9.5-T24, ADR-0037): con el worker listo y `WORKER_IDLE_EXIT_MINUTES`. */
let idleExit: IdleExit | null = null;
const heartbeatErrors = createErrorThrottle(logger, "no se pudo anotar el latido del worker");

async function shutdown(signal: string): Promise<void> {
  const reason: ShutdownReason = signal === "idle" ? "idle" : "signal";
  if (shuttingDown) {
    // Una señal durante el apagado solo (F9.5-T24): ya no se espera a los jobs, se cortan (Fly da
    // 45 s después de SIGTERM).
    if (reason === "signal" && shutdownReason === "idle") {
      shutdownReason = "signal";
      logger.info({ signal }, "señal durante el apagado solo: se cortan los jobs en curso");
      jobsAbort.abort();
    }
    return;
  }
  shuttingDown = true;
  shutdownReason = reason;
  idleExit?.stop();
  bossErrors.dispose();
  dbErrors.dispose();
  heartbeatErrors.dispose();
  // Con una señal se cortan los handlers; solo, sin trabajo, no se corta nada (un intento de
  // publicar cortado podría quedar `outcome_unknown`) y se espera más a los activos.
  const { abortJobs, gracefulStopMs } = stopOptionsFor(reason);
  logger.info({ signal }, "apagando el worker: esperando los jobs en curso");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se fuerza la salida");
    process.exit(1);
  }, gracefulStopMs + 10_000);
  force.unref();
  try {
    await stopWorker(
      {
        abortJobs: () => jobsAbort.abort(),
        // graceful: deja de tomar jobs nuevos y espera a los activos antes de cerrar el pool.
        stopBoss: () => boss.stop({ graceful: true, timeout: gracefulStopMs }),
        closeRenderer: () => renderer.close(),
        closeMarketplaceWindows: () => marketplaceWindows.closeAll(),
        stopHeartbeat: async () => {
          await heartbeat?.stop();
        },
        closeDatabase: () => database.close(),
      },
      logger,
      { abortJobs },
    );
    logger.info("worker detenido");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error al apagar el worker");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/**
 * Al arrancar (spec F1 §4.3 y §4.6, y F2 §4.4), sin impedir que el worker procese jobs si algo
 * falla:
 * 1. antes de conectar, borra el staging y los temporales de contenido de más de 24 h;
 * 2. ya conectado, cierra las cargas y corridas abandonadas en `running` y borra el staging de
 *    cargas terminadas;
 * 3. con las colas creadas, reencola las corridas de contenido en `queued` y las publicaciones en
 *    `publishing` (spec F3 §4.4), encola el sync de las de Portal en `live` (spec F4 §4.9) y el
 *    refresco de tokens (spec F3 §4.6).
 */
async function cleanStaging(withDatabase: boolean): Promise<void> {
  try {
    const removed = await staging.cleanup(
      withDatabase
        ? async (runId) => {
            const run = await importRuns.get(runId);
            if (run === null) return "missing";
            return isTerminalImportRun(run.status) ? "closed" : "open";
          }
        : undefined,
    );
    if (removed.length > 0) logger.info({ removed: removed.length }, "staging limpiado");
  } catch (error) {
    logger.warn({ err: error }, "no se pudo limpiar el staging; se intenta al próximo arranque");
  }
}

async function failAbandonedRuns(): Promise<void> {
  try {
    const closed = await importRuns.failAbandoned(
      new Date(Date.now() - IMPORT_RUN_ABANDONED_AFTER_MS),
      IMPORT_ABANDONED,
    );
    if (closed.length > 0) logger.warn({ importRunIds: closed }, "cargas abandonadas cerradas");
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar las cargas abandonadas");
  }
}

async function cleanContentTemps(): Promise<void> {
  try {
    const removed = await cleanContentTmp(contentTmpRoot);
    if (removed.length > 0)
      logger.info({ removed: removed.length }, "temporales de contenido borrados");
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron borrar los temporales de contenido");
  }
}

async function failAbandonedContent(): Promise<void> {
  try {
    const closed = await failAbandonedContentRuns(contentRuns);
    if (closed.length > 0) logger.warn({ contentRunIds: closed }, "corridas abandonadas cerradas");
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar las corridas abandonadas");
  }
}

async function failAbandonedPlans(): Promise<void> {
  try {
    const closed = await failAbandonedPlanRuns(planRuns);
    if (closed.length > 0) logger.warn({ planRunIds: closed }, "planes abandonados cerrados");
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar los planes abandonados");
  }
}

async function requeuePlans(): Promise<void> {
  try {
    const { requeued, failed } = await requeueQueuedPlanRuns(planRuns, queue);
    if (requeued > 0) logger.info({ requeued }, "planes de ideas en cola reencolados");
    if (failed.length > 0) {
      logger.warn(
        { planRunIds: failed },
        "no se pudieron reencolar algunos planes: se reintenta al próximo arranque o al pedirlos",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron reencolar los planes en cola");
  }
}

async function failAbandonedPostImages(): Promise<void> {
  try {
    const closed = await failAbandonedPostImageRuns(postImageRuns);
    if (closed.length > 0) {
      logger.warn({ postImageRunIds: closed }, "pedidos de imágenes abandonados cerrados");
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar los pedidos de imágenes abandonados");
  }
}

async function requeuePostImages(): Promise<void> {
  try {
    const { requeued, failed } = await requeueQueuedPostImageRuns(postImageRuns, queue);
    if (requeued > 0) logger.info({ requeued }, "pedidos de imágenes en cola reencolados");
    if (failed.length > 0) {
      logger.warn(
        { postImageRunIds: failed },
        "no se pudieron reencolar algunos pedidos de imágenes: se reintenta al próximo arranque",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron reencolar los pedidos de imágenes en cola");
  }
}

async function resumeAutoPublish(): Promise<void> {
  try {
    const resumed = await resumeAutoPublishAtStart({ ...autoPublish, contentRuns }, logger);
    if (resumed > 0) logger.info({ resumed }, "auto_publish cortados retomados");
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar los auto_publish cortados");
  }
}

async function requeueContent(): Promise<void> {
  try {
    const { requeued, failed } = await requeueQueuedContentRuns(contentRuns, queue);
    if (requeued > 0) logger.info({ requeued }, "corridas en cola reencoladas");
    if (failed.length > 0) {
      logger.warn(
        { contentRunIds: failed },
        "no se pudieron reencolar algunas corridas: se reintenta al próximo arranque o al pedirlas",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron reencolar las corridas en cola");
  }
  // Las de posts van a `post.draft`, nunca a `content.prepare` (F9-T05; su handler, F9-T11).
  try {
    const { requeued, failed } = await requeueQueuedPostRuns(contentRuns, queue);
    if (requeued > 0) logger.info({ requeued }, "corridas de posts en cola reencoladas");
    if (failed.length > 0) {
      logger.warn(
        { contentRunIds: failed },
        "no se pudieron reencolar algunas corridas de posts: se reintenta al próximo arranque",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron reencolar las corridas de posts en cola");
  }
}

async function requeuePublications(): Promise<void> {
  try {
    const { requeued, failed } = await requeuePublishingPublications(publications, queue);
    if (requeued > 0) logger.info({ requeued }, "publicaciones en curso reencoladas");
    if (failed.length > 0) {
      logger.warn(
        { publicationIds: failed },
        "no se pudieron reencolar algunas publicaciones: se reintenta al próximo arranque o al publicar",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron reencolar las publicaciones en curso");
  }
}

async function requestLiveSyncs(): Promise<void> {
  try {
    const { enqueued, alreadyQueued, failed } = await enqueueLiveSyncs(
      publications,
      platformAccounts,
      queue,
    );
    if (enqueued + alreadyQueued > 0) {
      logger.info({ enqueued, alreadyQueued }, "sync de las publicaciones de Portal encolado");
    }
    if (failed.length > 0) {
      logger.warn(
        { failed },
        "no se pudo encolar el sync de algunas publicaciones: se reintenta al próximo arranque o con Actualizar",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudo encolar el sync de las publicaciones de Portal");
  }
}

async function cleanMarketplaceEvidence(): Promise<void> {
  if (!marketplaceAutomation) return;
  try {
    const removed = await cleanContentTmp(
      marketplaceTmpRootOf(workspaceRoot),
      Date.now(),
      MARKETPLACE_EVIDENCE_MAX_AGE_MS,
    );
    if (removed.length > 0)
      logger.info({ removed: removed.length }, "evidencia de Marketplace borrada");
  } catch (error) {
    logger.warn({ err: error }, "no se pudo borrar la evidencia vieja de Marketplace");
  }
}

// También en producción: solo escribe en la base, y la de producción puede traer formularios de
// cuando el perfil corría en el Mac (sin ventana desde que no hay worker allí).
async function sweepMarketplaceWindows(): Promise<void> {
  try {
    const marked = await sweepClosedWindows(publications, new Date());
    if (marked > 0) {
      logger.info(
        { marked },
        "formularios de Marketplace sin ventana: esperan la palabra del operador",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "no se pudieron revisar los formularios de Marketplace abiertos");
  }
}

async function requestPublicationDue(): Promise<void> {
  try {
    await enqueuePublicationDue(queue);
  } catch (error) {
    logger.warn(
      { err: error },
      "no se pudo encolar la revisión de las programadas: la hace el cron del próximo minuto",
    );
  }
}

async function requestBackup(): Promise<void> {
  try {
    const decision = await requestBackupIfDue(queue, {
      readStatus: backupStatusOf(backupTarget),
      ...(env.PG_BIN_DIR === undefined ? {} : { binDir: env.PG_BIN_DIR }),
    });
    if (decision === "tool_missing") {
      logger.warn(
        "no se encontró pg_dump: el respaldo de la base no corre (brew install libpq, o PG_BIN_DIR en .env)",
      );
    }
  } catch (error) {
    logger.warn(
      { err: error },
      "no se pudo pedir el respaldo del arranque: lo hace el cron diario o el próximo arranque",
    );
  }
}

async function requestTokensRefresh(): Promise<void> {
  try {
    await enqueueTokensRefresh(queue);
  } catch (error) {
    logger.warn(
      { err: error },
      "no se pudo encolar el refresco de tokens: lo hace el cron diario o el próximo arranque",
    );
  }
}

try {
  await cleanStaging(false);
  await cleanContentTemps();
  await cleanMarketplaceEvidence();
  await boss.start();
  // Antes de registrar los jobs: así nunca marca una ventana que un intento acaba de abrir.
  await sweepMarketplaceWindows();
  await failAbandonedRuns();
  await failAbandonedContent();
  await failAbandonedPlans();
  await failAbandonedPostImages();
  await cleanStaging(true);
  // Una señal durante el arranque: `shutdown` ya está deteniendo pg-boss; no se registra nada más.
  const registered =
    !shuttingDown && (await registerJobs(boss, jobs, logger, { isStopping: () => shuttingDown }));
  if (registered) {
    heartbeat = await startHeartbeat({
      heartbeats: createWorkerHeartbeatRepository(database.db),
      processId: workerProcessId(randomUUID().slice(0, 8)),
      logger,
      errors: heartbeatErrors,
    });
    // Una señal mientras empezaba a latir: el apagado ya pasó por `stopHeartbeat` sin latido.
    if (shuttingDown) await heartbeat.stop();
    await requeueContent();
    await requeuePlans();
    await requeuePostImages();
    await requeuePublications();
    await resumeAutoPublish();
    await requestLiveSyncs();
    await requestTokensRefresh();
    await requestPublicationDue();
    await requestBackup();
    // El modo del worker solo decide si una publicación pedida en `live` se puede publicar (D11).
    logger.info(
      {
        jobs: jobs.map((job) => job.name),
        publishMode: env.PUBLISH_MODE,
      },
      "worker listo",
    );
    // Sin trabajo ni nada por vencer antes de la próxima revisión del horario, se apaga solo (exit
    // 0); esa revisión lo vuelve a encender (`worker-schedule.yml`, cada hora a los :50; ADR-0037).
    idleExit = shuttingDown
      ? null
      : startIdleExit({
          idleMinutes: env.WORKER_IDLE_EXIT_MINUTES,
          stayAheadMinutes: env.WORKER_STAY_AHEAD_MINUTES,
          probe: createIdleProbe({
            pendingJobs: pendingJobsOf(boss.getDb()),
            publications,
            ...(marketplaceAutomation
              ? { openMarketplaceWindows: () => marketplaceWindows.size() }
              : {}),
          }),
          onIdle: () => void shutdown("idle"),
          logger,
        });
    if (idleExit === null) {
      logger.warn(
        "Mientras el worker corre, Neon no se suspende y consume CU-horas: apágalo al terminar (ADR-0007).",
      );
    } else {
      logger.info(
        {
          idleMinutes: env.WORKER_IDLE_EXIT_MINUTES,
          stayAheadMinutes: env.WORKER_STAY_AHEAD_MINUTES,
        },
        "el worker se apaga solo cuando no tiene trabajo ni nada por vencer antes de la próxima revisión",
      );
    }
  }
} catch (error) {
  if (shuttingDown) {
    logger.debug({ err: error }, "arranque interrumpido por el apagado");
  } else {
    logger.error({ err: error }, "no se pudo arrancar el worker");
    process.exit(1);
  }
}
