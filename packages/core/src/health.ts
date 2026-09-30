import { z } from "zod";
import { PUBLISH_MODES } from "./enums.js";

/** Checks de `/health` (spec F0 §4.3). */
export const HEALTH_CHECK_NAMES = ["db", "storage", "queue"] as const;
export type HealthCheckName = (typeof HEALTH_CHECK_NAMES)[number];

export const healthCheckResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  error: z.string().optional(),
});
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;

/**
 * Contrato de `GET /health`. La API tipa su respuesta con él; la CLI y el panel validan con él
 * lo que reciben (puede responder otro servicio en el mismo puerto).
 */
export const healthReportSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  publishMode: z.enum(PUBLISH_MODES),
  checks: z.object({
    db: healthCheckResultSchema,
    storage: healthCheckResultSchema,
    queue: healthCheckResultSchema,
  }),
  version: z.string(),
});
export type HealthReport = z.infer<typeof healthReportSchema>;
