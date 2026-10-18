import type {
  BackupStatus,
  HealthCheckName,
  HealthCheckResult,
  HealthReport,
  PublishMode,
  WorkerHeartbeat,
} from "@agentsales/core";
import { HEALTH_CHECK_NAMES, isBackupStale, redactText, workerStatusOf } from "@agentsales/core";

/** Resuelve si el servicio está sano; lanza si no. */
export type HealthCheck = () => Promise<void>;

/** Tope por check: la base ya reintenta con 10 s por intento; nada debe colgar `/health`. */
export const DEFAULT_CHECK_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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
  /** Los corredores (slug) con `auto_publish` (F6-T10, spec §4.10); un error da `null`. */
  autoPublishBrokers?: () => Promise<string[]>;
  /** Los corredores (slug) que necesitan `ANTHROPIC_API_KEY` y no la tienen (F7-T12). */
  llmKeyMissingBrokers?: () => Promise<string[]>;
  /** Los latidos más recientes del worker (F8-T12, spec F8 §4.10); un error da `null`. */
  workerHeartbeats?: () => Promise<WorkerHeartbeat[]>;
  /** Los administradores activos sin el doble factor (F8-T15); un error da `null`. */
  adminsWithoutTotp?: () => Promise<string[]>;
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
  // Sin base no se consulta; con ella, el mismo tope de los checks: nunca cuelga `/health`.
  const brokerSlugs = async (read: () => Promise<string[]>) =>
    checks.db.ok ? await withTimeout(read(), timeoutMs).catch(() => null) : null;
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
      : {
          backup: await backupOf(
            details.backupStatus,
            timeoutMs,
            details.now ?? (() => new Date()),
          ),
        }),
    ...(details.autoPublishBrokers === undefined
      ? {}
      : { autoPublishBrokers: await brokerSlugs(details.autoPublishBrokers) }),
    ...(details.llmKeyMissingBrokers === undefined
      ? {}
      : { llmKeyMissingBrokers: await brokerSlugs(details.llmKeyMissingBrokers) }),
    ...(details.adminsWithoutTotp === undefined
      ? {}
      : { adminsWithoutTotp: await brokerSlugs(details.adminsWithoutTotp) }),
    ...(details.workerHeartbeats === undefined
      ? {}
      : {
          worker: await workerOf(
            checks.db.ok ? details.workerHeartbeats : null,
            timeoutMs,
            details.now ?? (() => new Date()),
          ),
        }),
  };
}

/** El worker según su último latido; `null` sin base o si no se pudo leer (nunca lanza). */
async function workerOf(
  read: (() => Promise<WorkerHeartbeat[]>) | null,
  timeoutMs: number,
  now: () => Date,
): Promise<HealthReport["worker"]> {
  if (read === null) return null;
  try {
    return workerStatusOf(await withTimeout(read(), timeoutMs), now());
  } catch {
    return null;
  }
}

/**
 * El estado del respaldo con `stale`; `null` sin respaldo o si no se pudo leer (nunca lanza). Con el
 * mismo tope de los checks: desde F8-T13 puede leerse de R2, que puede tardar.
 */
async function backupOf(
  read: () => Promise<BackupStatus | null>,
  timeoutMs: number,
  now: () => Date,
): Promise<HealthReport["backup"]> {
  let status: BackupStatus | null;
  try {
    status = await withTimeout(read(), timeoutMs);
  } catch {
    return null;
  }
  return status === null ? null : { ...status, stale: isBackupStale(status, now()) };
}
