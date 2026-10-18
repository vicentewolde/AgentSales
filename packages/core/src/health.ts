import { z } from "zod";
import { PUBLISH_MODES } from "./enums.js";
import { workerStatusSchema } from "./worker-heartbeat.js";

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
 * El estado del respaldo local (spec F6 §4.11): lo guarda el respaldo en un archivo de su carpeta
 * (sin tabla) y lo leen `/health` y la agenda. Solo horas, el nombre del archivo y un código: nunca
 * la ruta de la carpeta ni el mensaje del error.
 */
export const backupStatusSchema = z.object({
  /** El último respaldo bueno (ISO), o `null` si nunca hubo uno. */
  lastSuccessAt: z.string().nullable(),
  /** Su archivo (`agentsales-AAAAMMDD-HHMM.dump`), sin la carpeta. */
  lastFile: z.string().nullable(),
  /** La última falla (ISO) y su código, si fue después del último bueno. */
  lastFailureAt: z.string().nullable(),
  lastFailureCode: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

/** Un respaldo de más de 48 h (o ninguno) se avisa en `/health` y en la agenda. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000;

/** Si el último respaldo bueno es de hace más de 48 h, o no hay ninguno. */
export function isBackupStale(status: BackupStatus | null, now: Date): boolean {
  if (status?.lastSuccessAt == null) return true;
  const last = Date.parse(status.lastSuccessAt);
  // Una fecha ilegible cuenta como sin respaldo.
  return Number.isNaN(last) || now.getTime() - last > BACKUP_STALE_MS;
}

/**
 * Contrato de `GET /health`. La API tipa su respuesta con él; la CLI y el panel validan con él
 * lo que reciben (puede responder otro servicio en el mismo puerto).
 */
export const healthReportSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  publishMode: z.enum(PUBLISH_MODES),
  /**
   * Desde F8-T02 (spec §4.2): el ambiente del servidor, también sin sesión, para que `doctor` avise
   * si la CLI apunta a otro que el esperado. Opcional: una API anterior no lo trae.
   */
  environment: z.enum(["development", "production"]).optional(),
  /**
   * El detalle (desde F7-T05, spec F7 §4.3): `checks`, `version` y lo de abajo solo los ve el
   * administrador; sin sesión (o con la de un corredor) `/health` responde `status` y
   * `publishMode`.
   */
  checks: z
    .object({
      db: healthCheckResultSchema,
      storage: healthCheckResultSchema,
      queue: healthCheckResultSchema,
    })
    .optional(),
  version: z.string().optional(),
  /**
   * Desde F6-T14: la versión de Postgres del servidor (`show server_version`, por ejemplo `18.6`),
   * para que `doctor` la compare con la de `pg_dump`; `null` si la base no respondió. Opcional: un
   * reporte anterior no la trae.
   */
  database: z.object({ serverVersion: z.string().nullable() }).optional(),
  /**
   * Desde F6-T14: el estado del último respaldo, con `stale` (más de 48 h o ninguno); `null` si
   * nunca se respaldó o no se pudo leer el estado. Opcional, como `database`.
   */
  backup: backupStatusSchema.extend({ stale: z.boolean() }).nullable().optional(),
  /**
   * Desde F6-T10 (spec §4.10): los corredores (slug) con `auto_publish`. Con la API en `live` y la
   * lista no vacía, `status`, `doctor` y el panel lo dicen en rojo: publica sin revisión. `null` si
   * la base no respondió. Opcional, como `database`.
   */
  autoPublishBrokers: z.array(z.string()).nullable().optional(),
  /**
   * Desde F7-T12 (spec §4.7): los corredores (slug) que usan la API de Anthropic cuando falta
   * `ANTHROPIC_API_KEY` (sus textos fallarán con `LLM_NOT_CONFIGURED`); vacía si no falta o con
   * `LLM_PROVIDER=fake`. `null` si la base no respondió. Opcional, como `database`.
   */
  llmKeyMissingBrokers: z.array(z.string()).nullable().optional(),
  /**
   * Desde F8-T12 (spec §4.10): si el worker está encendido según su latido, desde cuándo y su
   * último latido. `null` si la base no respondió. Opcional, como `database`.
   */
  worker: workerStatusSchema.nullable().optional(),
});
export type HealthReport = z.infer<typeof healthReportSchema>;
