import type { RunImportDeps } from "@agentsales/core";
import { type ContentPrepareJobDeps, contentPrepareJob } from "./content-prepare.js";
import type { Job } from "./define.js";
import { importRunJob } from "./import-run.js";
import { type MarketplaceProfileJobDeps, marketplaceProfileJob } from "./marketplace-profile.js";
import { type PublicationPublishJobDeps, publicationPublishJob } from "./publication-publish.js";
import { type PublicationSyncJobDeps, publicationSyncJob } from "./publication-sync.js";
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
  /** El perfil del navegador de Marketplace: iniciar sesión y olvidarlo (spec F5 §4.2). */
  marketplaceProfile: MarketplaceProfileJobDeps;
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
    marketplaceProfileJob(deps.marketplaceProfile),
  ];
}
