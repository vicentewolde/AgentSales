import type { Logger } from "@agentsales/config";
import {
  MANUAL_CONFIRM_PLATFORMS,
  type PublicationRepository,
  SCHEDULE_OVERDUE_MS,
} from "@agentsales/core";
import { QUEUE_SCHEMA } from "@agentsales/queue";

// El worker se apaga solo (F9.5-T24, ADR-0037): cuando lleva `WORKER_IDLE_EXIT_MINUTES` seguidos sin
// nada que hacer ni nada programado que venza en los próximos `WORKER_STAY_AHEAD_MINUTES`, cierra
// limpio (el mismo apagado de SIGTERM: espera los jobs, cierra pg-boss y la base) y sale con 0. En
// Fly la máquina queda detenida (`[[restart]] policy = "on-failure"`) hasta que el workflow
// `worker-schedule.yml` la vuelve a encender en su próxima revisión (cada hora a los :50, de día):
// mirar 70 min adelante cubre lo que vence antes de esa revisión y su atraso en GitHub.

/** Cada cuánto se revisa si queda algo que hacer. */
export const IDLE_CHECK_INTERVAL_MS = 60_000;

/**
 * Los jobs que no cuentan como trabajo: `publication.due` corre cada minuto aunque no haya nada
 * (lo que sí cuenta es lo programado que vence, que se mira aparte).
 */
export const IDLE_IGNORED_JOBS = ["publication.due"] as const;

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
 * Lo que mantiene encendido al worker: un job activo o por empezar dentro de `marginMs`, una
 * publicación programada que vence dentro de `marginMs` (o venció hace menos de 12 h y todavía no
 * empieza: sale en la próxima vuelta) o un formulario de Marketplace abierto. Los recordatorios de
 * Marketplace no cuentan (los aprieta el operador) ni las atrasadas de más de 12 h (no salen solas).
 */
export function createIdleProbe(
  deps: IdleProbeDeps,
): (marginMs: number) => Promise<IdleReason | null> {
  const now = deps.now ?? (() => new Date());
  return async (marginMs) => {
    if ((deps.openMarketplaceWindows?.() ?? 0) > 0) return "marketplace_windows";
    if ((await deps.pendingJobs(marginMs)) > 0) return "jobs";
    const at = now();
    const due = await deps.publications.listDue({
      now: new Date(at.getTime() + marginMs),
      since: new Date(at.getTime() - SCHEDULE_OVERDUE_MS),
      excludePlatforms: [...MANUAL_CONFIRM_PLATFORMS],
      limit: 1,
    });
    return due.length > 0 ? "publications" : null;
  };
}

/** Lo que `pendingJobs` necesita de pg-boss (`boss.getDb()` lo cumple). */
export type QueueDb = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

/**
 * Cuenta en la tabla de pg-boss los jobs activos y los que esperan (`created` o `retry`) y empiezan
 * dentro de `withinMs`, sin los de `ignore`. Un job que espera más allá del margen (un reintento
 * con espera larga) no mantiene encendido al worker: corre al próximo encendido.
 */
export async function countPendingJobs(
  db: QueueDb,
  withinMs: number,
  ignore: readonly string[] = IDLE_IGNORED_JOBS,
): Promise<number> {
  const result = await db.executeSql(
    `select count(*)::int as count from ${QUEUE_SCHEMA}.job
      where name <> all($1::text[])
        and (state = 'active'
          or (state in ('created', 'retry') and start_after <= now() + make_interval(secs => $2)))`,
    [[...ignore], Math.ceil(withinMs / 1000)],
  );
  const row = result.rows[0] as { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

export type IdleExitDeps = {
  /** `WORKER_IDLE_EXIT_MINUTES`; 0 (o menos) no arranca nada: el worker nunca se apaga solo. */
  idleMinutes: number;
  /** `WORKER_STAY_AHEAD_MINUTES`: cuánto mira hacia adelante la revisión (lo que vence, los jobs). */
  stayAheadMinutes: number;
  probe: (marginMs: number) => Promise<IdleReason | null>;
  /** El apagado limpio (el mismo de SIGTERM). Se llama una sola vez. */
  onIdle: () => void;
  logger: Logger;
  now?: () => number;
  intervalMs?: number;
};

export type IdleExit = { stop(): void };

/**
 * Revisa cada minuto si queda algo que hacer (mirando `stayAheadMinutes` adelante): cada vez que hay
 * algo, el reloj vuelve a cero; cuando pasan `idleMinutes` seguidos sin nada, llama a `onIdle`. Si la
 * revisión falla (la base no respondió), no se sabe: cuenta como ocupado y no se apaga.
 * `null` si `idleMinutes` es 0: no se revisa nada.
 */
export function startIdleExit(deps: IdleExitDeps): IdleExit | null {
  if (deps.idleMinutes <= 0) return null;
  const now = deps.now ?? (() => Date.now());
  const idleMs = deps.idleMinutes * 60_000;
  const aheadMs = deps.stayAheadMinutes * 60_000;
  let idleSince = now();
  let checking = false;
  let stopped = false;
  let lastReason: IdleReason | "unknown" | null = null;
  const tick = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      let reason: IdleReason | "unknown" | null;
      try {
        reason = await deps.probe(aheadMs);
      } catch (error) {
        reason = "unknown";
        deps.logger.warn(
          { err: error },
          "no se pudo revisar si el worker tiene trabajo: sigue encendido",
        );
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
        stopped = true;
        clearInterval(timer);
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
  const timer = setInterval(() => void tick(), deps.intervalMs ?? IDLE_CHECK_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
