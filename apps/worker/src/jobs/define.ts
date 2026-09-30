import type { Logger } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import type { z } from "zod";

export type JobContext = { jobId: string; logger: Logger };

/**
 * Política de la cola de un job (ADR-0005). pg-boss la guarda al crear la cola; el worker la
 * vuelve a aplicar al arrancar, así que este código es la fuente de verdad.
 */
export type QueuePolicy = {
  /** Reintentos tras el primer intento. */
  retryLimit: number;
  /** Segundos antes del primer reintento. */
  retryDelay: number;
  /** Duplica la espera en cada reintento. */
  retryBackoff: boolean;
  /** Tope de un intento; si se supera, el job se marca como fallido y se reintenta. */
  expireInSeconds: number;
};

/** Job listo para registrar: valida sus datos con zod y luego llama al handler. */
export type Job = {
  name: string;
  queue: QueuePolicy;
  run(data: unknown, context: JobContext): Promise<void>;
};

/**
 * Define un job. Los datos vienen de la base, escritos por otro proceso (quizás otra versión del
 * código): son un borde y se validan con zod. Deben llevar solo ids, nunca secretos; el handler
 * recarga el estado desde la base, lo que además lo hace idempotente (ADR-0005).
 */
export function defineJob<S extends z.ZodType>(definition: {
  name: string;
  schema: S;
  queue: QueuePolicy;
  handler: (data: z.infer<S>, context: JobContext) => Promise<void>;
}): Job {
  const { name, schema, queue, handler } = definition;
  return {
    name,
    queue,
    async run(data, context) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new AppError("JOB_PAYLOAD_INVALID", `Datos inválidos para el job ${name}`, {
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });
      }
      await handler(parsed.data, context);
    },
  };
}
