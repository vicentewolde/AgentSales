import { JOB_PAYLOADS, type JobPayload } from "@agentsales/core";
import { defineJob } from "./define.js";

export const SYSTEM_PING = "system.ping";

/** El contrato vive en core (`JOB_PAYLOADS`), compartido con quien encola. */
export const systemPingSchema = JOB_PAYLOADS[SYSTEM_PING];
export type SystemPingData = JobPayload<typeof SYSTEM_PING>;

/** Job de prueba: responde "pong", opcionalmente tras `delayMs`. Sin reintentos. */
export const systemPing = defineJob({
  name: SYSTEM_PING,
  schema: systemPingSchema,
  queue: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 60 },
  handler: async ({ message, delayMs = 0 }, { logger }) => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    logger.info({ message, delayMs }, "pong");
  },
});
