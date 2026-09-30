import type {
  HealthCheckName,
  HealthCheckResult,
  HealthReport,
  PublishMode,
} from "@agentsales/core";
import { HEALTH_CHECK_NAMES, redactText } from "@agentsales/core";

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

/** Corre los checks en paralelo. `degraded` si alguno falla; nunca lanza. */
export async function runHealth(options: {
  checks: Record<HealthCheckName, HealthCheck>;
  publishMode: PublishMode;
  version: string;
  timeoutMs?: number;
}): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const results = await Promise.all(
    HEALTH_CHECK_NAMES.map(
      async (name) => [name, await runCheck(options.checks[name], timeoutMs)] as const,
    ),
  );
  // `results` recorre HEALTH_CHECK_NAMES completo, así que el objeto tiene todas las claves.
  const checks = Object.fromEntries(results) as Record<HealthCheckName, HealthCheckResult>;
  return {
    status: results.every(([, result]) => result.ok) ? "ok" : "degraded",
    publishMode: options.publishMode,
    checks,
    version: options.version,
  };
}
