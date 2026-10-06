import type { RunImportDeps } from "@agentsales/core";
import { type ContentPrepareJobDeps, contentPrepareJob } from "./content-prepare.js";
import type { Job } from "./define.js";
import { importRunJob } from "./import-run.js";
import { type PublicationPublishJobDeps, publicationPublishJob } from "./publication-publish.js";
import { systemPing } from "./system-ping.js";

export type JobDeps = {
  /** Dependencias de `runImport` (repositorios, R2, lector de xlsx y staging). */
  importRun: RunImportDeps;
  /** Dependencias de `prepareContent` y lo que se arma por intento (procesador y temporal). */
  contentPrepare: ContentPrepareJobDeps;
  /** Dependencias de `publishPublication`: repositorios, R2, publishers y el modo del worker. */
  publicationPublish: PublicationPublishJobDeps;
};

/** Jobs que procesa el worker, con sus dependencias inyectadas. Los de ADR-0005 llegan en su fase. */
export function buildJobs(deps: JobDeps): readonly Job[] {
  return [
    systemPing,
    importRunJob(deps.importRun),
    contentPrepareJob(deps.contentPrepare),
    publicationPublishJob(deps.publicationPublish),
  ];
}
