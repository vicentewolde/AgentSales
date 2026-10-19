import type { RunImportDeps } from "@agentsales/core";
import { type ContentPrepareJobDeps, contentPrepareJob } from "./content-prepare.js";
import { type DbBackupJobDeps, dbBackupJob } from "./db-backup.js";
import type { Job } from "./define.js";
import { importRunJob } from "./import-run.js";
import { type MarketplaceProfileJobDeps, marketplaceProfileJob } from "./marketplace-profile.js";
import { type PublicationDueJobDeps, publicationDueJob } from "./publication-due.js";
import { type PublicationPublishJobDeps, publicationPublishJob } from "./publication-publish.js";
import { type PublicationSyncJobDeps, publicationSyncJob } from "./publication-sync.js";
import { type PublicationsWatchJobDeps, publicationsWatchJob } from "./publications-watch.js";
import { systemPing } from "./system-ping.js";
import { type TokensRefreshJobDeps, tokensRefreshJob } from "./tokens-refresh.js";

export type JobDeps = {
  /** Dependencias de `runImport` (repositorios, R2, lector de xlsx y staging). */
  importRun: RunImportDeps;
  /** Dependencias de `prepareContent` y lo que se arma por intento (procesador y temporal). */
  contentPrepare: ContentPrepareJobDeps;
  /** Dependencias de `publishPublication`: repositorios, R2, publishers y el modo del worker. */
  publicationPublish: PublicationPublishJobDeps;
  /** Dependencias de `syncPublication`: el candado, el token de Portal y las operaciones. */
  publicationSync: PublicationSyncJobDeps;
  /** Cuentas conectadas e Instagram Login, para `tokens.refresh`. */
  tokensRefresh: TokensRefreshJobDeps;
  /**
   * El perfil del navegador de Marketplace: iniciar sesión y olvidarlo (spec F5 §4.2). `null` en
   * producción: el formulario automático no corre allí (spec F8 §4.10, D4), así que el job no se
   * registra y nada atiende un `marketplace.profile`.
   */
  marketplaceProfile: MarketplaceProfileJobDeps | null;
  /** El disparo de las programadas (spec F6 §4.4): el candado, la cola y lo que revisa publicar. */
  publicationDue: PublicationDueJobDeps;
  /** La vigilancia de cada hora (spec F6 §4.6): el sync de Portal y las atascadas. */
  publicationsWatch: PublicationsWatchJobDeps;
  /** El respaldo local de la base (spec F6 §4.11): diario y al arrancar si hace falta. */
  dbBackup: DbBackupJobDeps;
};

/** Jobs que procesa el worker, con sus dependencias inyectadas. Los de ADR-0005 llegan en su fase. */
export function buildJobs(deps: JobDeps): readonly Job[] {
  return [
    systemPing,
    importRunJob(deps.importRun),
    contentPrepareJob(deps.contentPrepare),
    publicationPublishJob(deps.publicationPublish),
    publicationSyncJob(deps.publicationSync),
    tokensRefreshJob(deps.tokensRefresh),
    ...(deps.marketplaceProfile === null ? [] : [marketplaceProfileJob(deps.marketplaceProfile)]),
    publicationDueJob(deps.publicationDue),
    publicationsWatchJob(deps.publicationsWatch),
    dbBackupJob(deps.dbBackup),
  ];
}
