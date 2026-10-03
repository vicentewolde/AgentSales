import type { Logger } from "@agentsales/config";
import { AppError, JOB_PAYLOADS, type JobName, type JobPayload } from "@agentsales/core";

export type JobContext = {
  jobId: string;
  logger: Logger;
  /** Si es el último intento (`retryCount >= retryLimit`): un error ya no se reintentará. */
  isLastAttempt: boolean;
};

/**
 * Política de la cola de un job (ADR-0005). pg-boss la guarda al crear la cola; el worker la
 * vuelve a aplicar al arrancar, así que este código es la fuente de verdad.
 */
export type QueuePolicy = {
  /**
   * Política de pg-boss (por defecto `standard`). Solo algunas deduplican por `singletonKey`
   * (`exclusive`: un solo job en cola, en reintento o activo por clave). **No se puede cambiar
   * después de crear la cola**: se pasa solo a `createQueue` (cambiarla exige borrar la cola).
   */
  policy?: "standard" | "exclusive";
  /** Reintentos tras el primer intento. */
  retryLimit: number;
  /** Segundos antes del primer reintento. */
  retryDelay: number;
  /** Duplica la espera en cada reintento. */
  retryBackoff: boolean;
  /** Tope de un intento; si se supera, el job se marca como fallido y se reintenta. */
  expireInSeconds: number;
};

/** Campos del log de un intento que falló (por defecto, el error completo: `{ err }`). */
export type ErrorLogFields = (error: unknown) => Record<string, unknown>;

/** Job listo para registrar: valida sus datos con zod y luego llama al handler. */
export type Job = {
  name: JobName;
  queue: QueuePolicy;
  run(data: unknown, context: JobContext): Promise<void>;
  /**
   * Qué se registra de un error. Un job cuyos errores pueden traer datos del aviso (por ejemplo, en
   * la causa de un `INTERNAL_ERROR`) registra solo el código.
   */
  errorLogFields?: ErrorLogFields;
};

/**
 * Define un job del contrato de core: el nombre sale de `JOB_NAMES` y los datos se validan con
 * `JOB_PAYLOADS[name]`, los mismos que usa quien encola. Los datos vienen de la base, escritos por
 * otro proceso (quizás otra versión del código): son un borde. Llevan solo ids, nunca secretos; el
 * handler recarga el estado desde la base, lo que además lo hace idempotente (ADR-0005).
 */
export function defineJob<N extends JobName>(definition: {
  name: N;
  queue: QueuePolicy;
  handler: (data: JobPayload<N>, context: JobContext) => Promise<void>;
  errorLogFields?: ErrorLogFields;
}): Job {
  const { name, queue, handler, errorLogFields } = definition;
  const schema = JOB_PAYLOADS[name];
  return {
    name,
    queue,
    ...(errorLogFields === undefined ? {} : { errorLogFields }),
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
      // zod no estrecha `JOB_PAYLOADS[name]` por `N`: el esquema es justamente el de `N`.
      await handler(parsed.data as JobPayload<N>, context);
    },
  };
}
