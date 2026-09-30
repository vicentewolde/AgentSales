import type { JobHandler } from "./registry.js";

export const SYSTEM_PING = "system.ping";

/** Tope del trabajo simulado: solo sirve para probar el apagado con un job en curso. */
export const MAX_PING_DELAY_MS = 10_000;

export type SystemPingData = { message?: string; delayMs?: number };

function delayOf(data: unknown): number {
  if (typeof data !== "object" || data === null || !("delayMs" in data)) {
    return 0;
  }
  const { delayMs } = data;
  return typeof delayMs === "number" && Number.isFinite(delayMs)
    ? Math.min(Math.max(delayMs, 0), MAX_PING_DELAY_MS)
    : 0;
}

/** Job de prueba: responde "pong" con lo recibido, opcionalmente tras `delayMs`. */
export const systemPing: JobHandler = async (data, { logger }) => {
  const delayMs = delayOf(data);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  logger.info({ data, delayMs }, "pong");
};
