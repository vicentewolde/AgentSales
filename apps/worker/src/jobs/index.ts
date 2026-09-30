import type { JobRegistry } from "./registry.js";
import { SYSTEM_PING, systemPing } from "./system-ping.js";

/** Jobs que procesa el worker. Los de ADR-0005 se agregan en su fase. */
export const JOBS: JobRegistry = {
  [SYSTEM_PING]: systemPing,
};
