import { z } from "zod";
import { defineJob } from "./define.js";

export const SYSTEM_PING = "system.ping";

/** Tope del trabajo simulado: solo sirve para probar el apagado con un job en curso. */
export const MAX_PING_DELAY_MS = 10_000;

export const systemPingSchema = z.object({
  message: z.string().max(200).optional(),
  delayMs: z.number().int().min(0).max(MAX_PING_DELAY_MS).optional(),
});
export type SystemPingData = z.infer<typeof systemPingSchema>;

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
