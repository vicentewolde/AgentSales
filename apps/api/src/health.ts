import { redactText } from "@agentsales/config";
import type { PublishMode } from "@agentsales/core";

export const CHECK_NAMES = ["db", "storage", "queue"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** Resuelve si el servicio está sano; lanza si no. */
export type HealthCheck = () => Promise<void>;

export type CheckResult = { ok: boolean; latencyMs: number; error?: string };

export type HealthReport = {
  status: "ok" | "degraded";
  publishMode: PublishMode;
  checks: Record<CheckName, CheckResult>;
  version: string;
};

/** Tope por check: la base ya reintenta con 10 s por intento; nada debe colgar `/health`. */
export const DEFAULT_CHECK_TIMEOUT_MS = 25_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<CheckResult> {
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
  checks: Record<CheckName, HealthCheck>;
  publishMode: PublishMode;
  version: string;
  timeoutMs?: number;
}): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const results = await Promise.all(
    CHECK_NAMES.map(
      async (name) => [name, await runCheck(options.checks[name], timeoutMs)] as const,
    ),
  );
  const checks = Object.fromEntries(results) as Record<CheckName, CheckResult>;
  return {
    status: results.every(([, result]) => result.ok) ? "ok" : "degraded",
    publishMode: options.publishMode,
    checks,
    version: options.version,
  };
}
