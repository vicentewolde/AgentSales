import { z } from "zod";
import { contentRunErrorSchema } from "./content.js";
import { PLAN_RUN_STATUSES } from "./enums.js";
import { llmUsageSchema } from "./llm-usage.js";

/**
 * Un plan de ideas de la IA para un período (`plan_runs`, job `content.plan`, ADR-0030). La lógica
 * llega en F9-T20: aquí solo la fila. `request` y `report` son jsonb que T20 define con su propio
 * esquema (lo pedido y lo propuesto); hasta entonces se guardan tal cual, sin secretos.
 */
export const planRunSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  periodStart: z.date(),
  periodEnd: z.date(),
  status: z.enum(PLAN_RUN_STATUSES),
  /** Lo pedido (redes, cuántas ideas…), sin secretos. */
  request: z.record(z.string(), z.unknown()),
  /** Lo que propuso y lo que descartaron las verificaciones; `null` hasta que termina. */
  report: z.unknown().nullable(),
  /** `{ code, message }` cuando `status = failed`. */
  error: contentRunErrorSchema.nullable(),
  /** Lo gastado en IA, sumado por llamada (spec F9 §4.12); `null` si no llamó al modelo. */
  llmUsage: llmUsageSchema.nullable(),
  /** `SOCIAL_PROMPT_VERSION` con que corrió (ADR-0030, punto 6); `null` antes de llamar a la IA. */
  promptVersion: z.string().nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PlanRun = z.infer<typeof planRunSchema>;
