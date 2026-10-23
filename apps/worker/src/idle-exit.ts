import { createErrorThrottle, type Logger } from "@agentsales/config";
import { dueQuery, type JobName, type PublicationRepository } from "@agentsales/core";
import { countPendingJobs, type QueueSql } from "@agentsales/queue";

// El worker se apaga solo (F9.5-T24, ADR-0037): cuando lleva `WORKER_IDLE_EXIT_MINUTES` seguidos sin
// nada que hacer ni nada programado que venza en los próximos `WORKER_STAY_AHEAD_MINUTES`, cierra
// limpio (sin cortar los jobs: el apagado espera a que terminen, `stopOptionsFor("idle")`) y sale
// con 0. En Fly la máquina queda detenida (`[[restart]] policy = "on-failure"`) hasta que el
// workflow `worker-schedule.yml` la vuelve a encender en su próxima revisión (cada hora a los :50,
// de día): mirar 70 min adelante cubre lo que vence antes de esa revisión y su atraso en GitHub.

/** Cada cuánto se revisa si queda algo que hacer. */
export const IDLE_CHECK_INTERVAL_MS = 60_000;

/**
 * Los jobs que no cuentan como trabajo (los internos de pg-boss tampoco, `countPendingJobs`):
 * `publication.due` corre cada minuto aunque no haya nada (lo que sí cuenta es lo programado que
 * vence, que se mira aparte) y `publications.watch` cada hora (es vigilancia, y el arranque ya hace
 * lo mismo): contarlos alargaría cada encendido sin motivo.
 */
export const IDLE_IGNORED_JOBS: readonly JobName[] = ["publication.due", "publications.watch"];

/** Por qué el worker sigue encendido (para el log), o `null` si no queda nada que hacer. */
export type IdleReason = "jobs" | "publications" | "marketplace_windows";

export type IdleProbeDeps = {
  /** Jobs activos, o en cola que empiezan dentro del margen (sin `IDLE_IGNORED_JOBS`). */
  pendingJobs(withinMs: number): Promise<number>;
  publications: Pick<PublicationRepository, "listDue">;
  /** Formularios de Marketplace abiertos esperando al operador (solo en el Mac). */
  openMarketplaceWindows?: () => number;
  now?: () => Date;
};

/**
 * Lo que mantiene encendido al worker: un formulario de Marketplace abierto, un job activo o por
 * empezar dentro de `aheadMs`, o una publicación programada que vence dentro de `aheadMs` o venció y
 * todavía sale sola (la regla del disparo, `dueQuery` de core: sin los recordatorios de Marketplace
 * ni las atrasadas de más de 12 h).
 */
export function createIdleProbe(
  deps: IdleProbeDeps,
): (aheadMs: number) => Promise<IdleReason | null> {
  const now = deps.now ?? (() => new Date());
  return async (aheadMs) => {
    if ((deps.openMarketplaceWindows?.() ?? 0) > 0) return "marketplace_windows";
    if ((await deps.pendingJobs(aheadMs)) > 0) return "jobs";
    const due = await deps.publications.listDue({ ...dueQuery(now(), aheadMs), limit: 1 });
    return due.length > 0 ? "publications" : null;
  };
}

/** Los jobs pendientes en la cola de pg-boss (`boss.getDb()`), sin `IDLE_IGNORED_JOBS`. */
export const pendingJobsOf = (db: QueueSql) => (withinMs: number) =>
  countPendingJobs(db, { withinMs, ignore: IDLE_IGNORED_JOBS });

export type IdleExitDeps = {
  /** `WORKER_IDLE_EXIT_MINUTES`; 0 (o menos) no arranca nada: el worker nunca se apaga solo. */
  idleMinutes: number;
  /** `WORKER_STAY_AHEAD_MINUTES`: cuánto mira hacia adelante la revisión (lo que vence, los jobs). */
  stayAheadMinutes: number;
  probe: (aheadMs: number) => Promise<IdleReason | null>;
  /** El apagado limpio (sin cortar los jobs). Se llama una sola vez. */
  onIdle: () => void;
  logger: Logger;
  /** Resume los errores repetidos de la revisión (por defecto, `createErrorThrottle`). */
  errors?: { report(error: unknown): void; dispose(): void };
  now?: () => number;
  intervalMs?: number;
};

export type IdleExit = { stop(): void };

/**
 * Revisa cada minuto si queda algo que hacer (mirando `stayAheadMinutes` adelante): cada vez que hay
 * algo, el reloj vuelve a cero; cuando pasan `idleMinutes` seguidos sin nada, llama a `onIdle` justo
 * después de una revisión vacía. Si la revisión falla (la base no respondió), no se sabe: cuenta
 * como ocupado y no se apaga; el error se resume en el log (no uno por minuto).
 * `null` si `idleMinutes` es 0: no se revisa nada.
 */
export function startIdleExit(deps: IdleExitDeps): IdleExit | null {
  if (deps.idleMinutes <= 0) return null;
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalMs ?? IDLE_CHECK_INTERVAL_MS;
  // Una revisión por minuto: sin esto, cada falla sería un aviso nuevo. Un resumen cada 30 min, y
  // la falla se da por pasada recién tras tres revisiones sin error.
  const errors =
    deps.errors ??
    createErrorThrottle(
      deps.logger,
      "no se pudo revisar si el worker tiene trabajo: sigue encendido",
      { summaryEveryMs: 30 * 60_000, recoveredAfterMs: 3 * intervalMs },
    );
  const idleMs = deps.idleMinutes * 60_000;
  const aheadMs = deps.stayAheadMinutes * 60_000;
  let idleSince = now();
  let checking = false;
  let stopped = false;
  let lastReason: IdleReason | "unknown" | null = null;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    errors.dispose();
  };
  const tick = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      let reason: IdleReason | "unknown" | null;
      try {
        reason = await deps.probe(aheadMs);
      } catch (error) {
        reason = "unknown";
        errors.report(error);
      }
      if (stopped) return;
      if (reason !== null) {
        idleSince = now();
        if (reason !== lastReason) deps.logger.debug({ reason }, "el worker tiene trabajo");
        lastReason = reason;
        return;
      }
      lastReason = null;
      if (now() - idleSince >= idleMs) {
        stop();
        deps.logger.info(
          { idleMinutes: deps.idleMinutes, stayAheadMinutes: deps.stayAheadMinutes },
          "sin trabajo ni nada por vencer: el worker se apaga solo hasta la próxima revisión del horario",
        );
        deps.onIdle();
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop };
}
