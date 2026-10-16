import type {
  BackupStatus,
  HealthCheckName,
  HealthCheckResult,
  HealthReport,
  PublishMode,
} from "@agentsales/core";
import { HEALTH_CHECK_NAMES, isBackupStale, redactText } from "@agentsales/core";

/** Resuelve si el servicio está sano; lanza si no. */
export type HealthCheck = () => Promise<void>;

/** Tope por check: la base ya reintenta con 10 s por intento; nada debe colgar `/health`. */
export const DEFAULT_CHECK_TIMEOUT_MS = 25_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<HealthCheckResult> {
  const start = performance.now();
  const latency = () => Math.round(performance.now() - start);
  try {
    await withTimeout(check(), timeoutMs);
    return { ok: true, latencyMs: latency() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, latencyMs: latency(), error: redactText(message) };
  }
}

/** Lo que `/health` informa además de los checks (F6-T14). */
export type HealthDetails = {
  /**
   * La versión de Postgres que leyó el check de la base (`readServerVersion`, que también sirve de
   * ping); se pide después de los checks. `null` si no la leyó.
   */
  serverVersion?: () => string | null;
  /** El estado del último respaldo (`readBackupStatus`); un error cuenta como sin respaldo. */
  backupStatus?: () => Promise<BackupStatus | null>;
  now?: () => Date;
};

/** Corre los checks en paralelo. `degraded` si alguno falla; nunca lanza. */
export async function runHealth(options: {
  checks: Record<HealthCheckName, HealthCheck>;
  publishMode: PublishMode;
  version: string;
  timeoutMs?: number;
  details?: HealthDetails;
}): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const results = await Promise.all(
    HEALTH_CHECK_NAMES.map(
      async (name) => [name, await runCheck(options.checks[name], timeoutMs)] as const,
    ),
  );
  // `results` recorre HEALTH_CHECK_NAMES completo, así que el objeto tiene todas las claves.
  const checks = Object.fromEntries(results) as Record<HealthCheckName, HealthCheckResult>;
  const details = options.details ?? {};
  return {
    status: results.every(([, result]) => result.ok) ? "ok" : "degraded",
    publishMode: options.publishMode,
    checks,
    version: options.version,
    ...(details.serverVersion === undefined
      ? {}
      : { database: { serverVersion: checks.db.ok ? details.serverVersion() : null } }),
    ...(details.backupStatus === undefined
      ? {}
      : { backup: await backupOf(details.backupStatus, details.now ?? (() => new Date())) }),
  };
}

/** El estado del respaldo con `stale`; `null` sin respaldo o si no se pudo leer (nunca lanza). */
async function backupOf(
  read: () => Promise<BackupStatus | null>,
  now: () => Date,
): Promise<HealthReport["backup"]> {
  let status: BackupStatus | null;
  try {
    status = await read();
  } catch {
    return null;
  }
  return status === null ? null : { ...status, stale: isBackupStale(status, now()) };
}
