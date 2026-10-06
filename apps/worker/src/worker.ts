import { createHash } from "node:crypto";
import {
  createErrorThrottle,
  createLogger,
  createSecretBox,
  findWorkspaceRoot,
  loadEnv,
  loadEnvFile,
} from "@agentsales/config";
import type { RunImportDeps } from "@agentsales/core";
import {
  createBrokerRepository,
  createContentRepository,
  createContentRunRepository,
  createDb,
  createFieldDefinitionRepository,
  createImportRunRepository,
  createListingRepository,
  createMediaRepository,
  createPlatformAccountRepository,
  createPublicationRepository,
  toPgConnectionString,
} from "@agentsales/db";
import { readListingsWorkbook } from "@agentsales/importers";
import { createStaging, stagingRootOf } from "@agentsales/importers/staging";
import { createLlmProvider } from "@agentsales/llm";
import { createHtmlRenderer, createMediaProcessor } from "@agentsales/media";
import { createInstagramAuth, createInstagramPublisher } from "@agentsales/publishers";
import { createBoss, jobQueueFromBoss } from "@agentsales/queue";
import { createR2Storage } from "@agentsales/storage";
import { createSlideTemplates } from "@agentsales/templates";
import { cleanContentTmp, contentTmpRootOf } from "./content-tmp.js";
import { failAbandonedContentRuns, requeueQueuedContentRuns } from "./jobs/content-prepare.js";
import { IMPORT_ABANDONED, IMPORT_RUN_ABANDONED_AFTER_MS } from "./jobs/import-run.js";
import { buildJobs } from "./jobs/index.js";
import { instagramNoteLogger, requeuePublishingPublications } from "./jobs/publication-publish.js";
import { registerJobs } from "./jobs/registry.js";
import { enqueueTokensRefresh } from "./jobs/tokens-refresh.js";
import { llmProviderOptions } from "./llm-options.js";
import { stopWorker } from "./shutdown.js";

/** Tiempo que se espera a que terminen los jobs en curso al apagar. */
const GRACEFUL_STOP_MS = 30_000;

loadEnvFile();
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
const staging = createStaging({
  root: stagingRootOf(workspaceRoot),
  maxVideoBytes: env.MAX_VIDEO_MB * 1024 * 1024,
});
const contentTmpRoot = contentTmpRootOf(workspaceRoot);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
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
const importRun: RunImportDeps = {
  ...repositories,
  importRuns,
  storage,
  sha256: async (text) => sha256(text),
  readSheet: (input) => readListingsWorkbook(input.xlsxPath),
  openMedia: (request) => staging.openMedia(request),
  discardStaging: (runId) => staging.discard(runId),
};
// Un Chromium por proceso (spec F2 §4.2): se abre al primer render y se cierra al apagar, después
// de que pg-boss detuvo los handlers (`stopWorker`).
const renderer = createHtmlRenderer();
// Se dispara al apagar: los handlers cortan ffmpeg, Chromium y la CLI de Claude (que corre en su
// propio grupo de procesos y no recibe el Ctrl+C de la terminal).
const jobsAbort = new AbortController();
// Publicar (spec F3 §4.4): las credenciales se descifran con la clave de APP_ENCRYPTION_KEY.
const publications = createPublicationRepository(database.db);
const platformAccounts = createPlatformAccountRepository(database.db, {
  secretBox: createSecretBox(env.APP_ENCRYPTION_KEY),
});
// Registrado en los dos modos: una publicación en `dry_run` también lo necesita (lo envuelve
// `withDryRun`). El cliente de Instagram se arma recién al primer intento en `live` (perezoso).
const instagram = createInstagramPublisher({ onNote: instagramNoteLogger(logger) });
// Refresco de tokens (spec F3 §4.6): solo usa el token, así que funciona sin el par de la app
// (como en la API); el par lo necesita solo el canje del OAuth, que el worker no hace.
const instagramAuth = createInstagramAuth({
  appId: env.INSTAGRAM_APP_ID ?? "",
  appSecret: env.INSTAGRAM_APP_SECRET ?? "",
  redirectUri: env.INSTAGRAM_REDIRECT_URI,
});
const jobs = buildJobs({
  importRun,
  contentPrepare: {
    shared: {
      ...repositories,
      contentRuns,
      storage,
      templates: createSlideTemplates(),
      renderer,
      llm: createLlmProvider(llmProviderOptions(env, process.env)),
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
  },
  publicationPublish: {
    shared: {
      publications,
      platformAccounts,
      contents: createContentRepository(database.db),
      media: repositories.media,
      listings: repositories.listings,
      storage,
      publishers: { instagram },
      workerMode: env.PUBLISH_MODE,
    },
    signal: jobsAbort.signal,
  },
  tokensRefresh: { platformAccounts, instagram: instagramAuth, signal: jobsAbort.signal },
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

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  bossErrors.dispose();
  dbErrors.dispose();
  logger.info({ signal }, "apagando el worker: esperando los jobs en curso");
  const force = setTimeout(() => {
    logger.error("el apagado tardó demasiado; se fuerza la salida");
    process.exit(1);
  }, GRACEFUL_STOP_MS + 10_000);
  force.unref();
  try {
    await stopWorker(
      {
        abortJobs: () => jobsAbort.abort(),
        // graceful: deja de tomar jobs nuevos y espera a los activos antes de cerrar el pool.
        stopBoss: () => boss.stop({ graceful: true, timeout: GRACEFUL_STOP_MS }),
        closeRenderer: () => renderer.close(),
        closeDatabase: () => database.close(),
      },
      logger,
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
 *    `publishing` (spec F3 §4.4), y encola el refresco de tokens (spec F3 §4.6).
 */
async function cleanStaging(withDatabase: boolean): Promise<void> {
  try {
    const removed = await staging.cleanup(
      withDatabase
        ? async (runId) => {
            const run = await importRuns.get(runId);
            if (run === null) return "missing";
            return run.status === "succeeded" || run.status === "failed" ? "closed" : "open";
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
  await boss.start();
  await failAbandonedRuns();
  await failAbandonedContent();
  await cleanStaging(true);
  // Una señal durante el arranque: `shutdown` ya está deteniendo pg-boss; no se registra nada más.
  const registered =
    !shuttingDown && (await registerJobs(boss, jobs, logger, { isStopping: () => shuttingDown }));
  if (registered) {
    await requeueContent();
    await requeuePublications();
    await requestTokensRefresh();
    // El modo del worker solo decide si una publicación pedida en `live` se puede publicar (D11).
    logger.info(
      {
        jobs: jobs.map((job) => job.name),
        publishMode: env.PUBLISH_MODE,
      },
      "worker listo",
    );
    logger.warn(
      "Mientras el worker corre, Neon no se suspende y consume CU-horas: apágalo al terminar (ADR-0007).",
    );
  }
} catch (error) {
  if (shuttingDown) {
    logger.debug({ err: error }, "arranque interrumpido por el apagado");
  } else {
    logger.error({ err: error }, "no se pudo arrancar el worker");
    process.exit(1);
  }
}
