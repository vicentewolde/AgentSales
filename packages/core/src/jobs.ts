import { z } from "zod";

/**
 * Contrato de los jobs (ADR-0005), compartido por quien encola (API, scripts) y el worker: una sola
 * fuente para los nombres y los datos. Los datos llevan solo ids, nunca secretos ni estado; el
 * handler recarga el estado desde la base. Los demás jobs de ADR-0005 se agregan en su fase.
 */
export const JOB_NAMES = [
  "system.ping",
  "import.run",
  "content.prepare",
  "publication.publish",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Tope del trabajo simulado de `system.ping`: solo sirve para probar el apagado del worker. */
export const MAX_PING_DELAY_MS = 10_000;

export const JOB_PAYLOADS = {
  /** Job de prueba (`pnpm worker:ping`). */
  "system.ping": z.object({
    message: z.string().max(200).optional(),
    delayMs: z.number().int().min(0).max(MAX_PING_DELAY_MS).optional(),
  }),
  /** Una carga de propiedades (spec F1 §4.6): el run guarda la entrada; el job lleva su id. */
  "import.run": z.object({ importRunId: z.uuid() }),
  /** Una corrida de contenido (spec F2 §4.4): la corrida guarda lo pedido; el job lleva su id. */
  "content.prepare": z.object({ contentRunId: z.uuid() }),
  /** Un intento de publicación (spec F3 §4.4): la publicación guarda lo aprobado y el modo. */
  "publication.publish": z.object({ publicationId: z.uuid() }),
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayload<N extends JobName> = z.infer<(typeof JOB_PAYLOADS)[N]>;
