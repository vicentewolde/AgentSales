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
  "publication.sync",
  "tokens.refresh",
  "marketplace.profile",
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
  /**
   * Leer el estado de una publicación de Portal en Mercado Libre y ajustarlo (spec F4 §4.9): lo
   * encolan las operaciones si la respuesta se perdió (F4-T17), el worker después de publicar y al
   * arrancar (T18) y la API a pedido (T19). La cola y su política las define el worker (T18).
   */
  "publication.sync": z.object({ publicationId: z.uuid() }),
  /**
   * El refresco de los tokens de las cuentas conectadas (spec F3 §4.6): lo encola el worker al
   * arrancar y su cron diario. Sin datos: el lote lee las cuentas de la base.
   */
  "tokens.refresh": z.object({}),
  /**
   * El perfil del navegador de Marketplace de un corredor (spec F5 §4.2 y §4.11, ADR-0017): `login`
   * abre la ventana para que el operador inicie sesión y conecta la cuenta (`label` es el nombre
   * que verá; `requestedAt`, cuándo se pidió); `forget` cierra sus ventanas y borra la carpeta. Los
   * dos por la misma cola, exclusiva por corredor: nunca se cruzan.
   */
  "marketplace.profile": z.discriminatedUnion("action", [
    z.object({
      brokerId: z.uuid(),
      action: z.literal("login"),
      label: z.string().trim().min(1).max(80).optional(),
      requestedAt: z.iso.datetime(),
    }),
    z.object({ brokerId: z.uuid(), action: z.literal("forget") }),
  ]),
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayload<N extends JobName> = z.infer<(typeof JOB_PAYLOADS)[N]>;
