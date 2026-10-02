import type { RunImportDeps } from "@agentsales/core";
import type { Job } from "./define.js";
import { importRunJob } from "./import-run.js";
import { systemPing } from "./system-ping.js";

export type JobDeps = {
  /** Dependencias de `runImport` (repositorios, R2, lector de xlsx y staging). */
  importRun: RunImportDeps;
};

/** Jobs que procesa el worker, con sus dependencias inyectadas. Los de ADR-0005 llegan en su fase. */
export function buildJobs(deps: JobDeps): readonly Job[] {
  return [systemPing, importRunJob(deps.importRun)];
}
