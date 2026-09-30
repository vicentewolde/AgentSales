import type { Job } from "./define.js";
import { systemPing } from "./system-ping.js";

/**
 * Jobs que procesa el worker. Los de ADR-0005 se agregan en su fase; cuando necesiten db,
 * storage o llm, esto pasa a ser `buildJobs(deps)` con las dependencias inyectadas.
 */
export const JOBS: readonly Job[] = [systemPing];
