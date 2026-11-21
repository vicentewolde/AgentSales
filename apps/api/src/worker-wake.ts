import { createErrorThrottle, type Logger } from "@agentsales/config";
import {
  dueQuery,
  type JobQueue,
  type PublicationRepository,
  type WorkerHeartbeatRepository,
} from "@agentsales/core";

// La API enciende el worker detenido cuando hay trabajo (ADR-0044). El worker se apaga solo sin
// trabajo (F9.5-T24, ADR-0037, `WORKER_IDLE_EXIT_MINUTES`), y la API, que queda siempre encendida
// (`min_machines_running = 1`), lo vuelve a encender con la API de Machines de Fly:
// - al encolar un trabajo (`wakingQueue`), sin consultar la base;
// - con un temporizador en memoria: mientras el worker corre, solo pregunta a Fly (sin Neon); con
//   el worker detenido, consulta la base **una vez** para saber cuándo vence lo próximo (una
//   programada, un job que espera o el mantenimiento diario) y no vuelve a consultarla hasta esa
//   hora (menos `leadMs`), hasta que un pedido que escribe la avisa (`poke`) o, como mucho, cada
//   `recheckMs`. Así Neon se despierta pocas veces al día por esto (costo en el ADR).
// El token nunca se loguea ni va en un error: solo el estado HTTP.

/** El grupo de procesos del worker en `fly.toml` (`[processes]`). */
export const FLY_WORKER_PROCESS_GROUP = "worker";

/** Una máquina del worker y su estado en Fly (`started`, `stopped`, `suspended`, `starting`…). */
export type WorkerMachine = { id: string; state: string };

/** Lo que la API usa de Fly: listar las máquinas del worker y encender una. */
export type WorkerMachines = {
  list(): Promise<WorkerMachine[]>;
  start(id: string): Promise<void>;
};

/** Un error de la API de Machines: solo la operación y el estado HTTP (nunca el token). */
export class FlyMachinesError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FlyMachinesError";
    this.status = status;
  }
}

export type FlyWorkerMachinesOptions = {
  /** `FLY_MACHINES_API_URL`: la interna (`http://_api.internal:4280`) o `https://api.machines.dev`. */
  apiUrl: string;
  /** `FLY_APP_NAME` (lo pone Fly en cada máquina). */
  appName: string;
  /** `FLY_WORKER_WAKE_TOKEN`. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * `fly tokens create` entrega el token con el prefijo `FlyV1 `: así se manda tal cual; uno sin
 * prefijo va como `Bearer` (docs.fly.io/machines/api/working-with-machines-api, "Authentication").
 */
export function flyAuthorization(token: string): string {
  const value = token.trim();
  return value.startsWith("FlyV1 ") ? value : `Bearer ${value}`;
}

const SLEEPING_STATES = new Set(["stopped", "suspended", "created"]);
const AWAKE_STATES = new Set(["started", "starting"]);

/**
 * El adaptador de la API de Machines (docs.fly.io/machines/api/machines-resource):
 * `GET /v1/apps/{app}/machines?metadata.fly_process_group=worker` y
 * `POST /v1/apps/{app}/machines/{id}/start`. El grupo se vuelve a filtrar aquí por
 * `config.metadata.fly_process_group`, por si el filtro de la consulta no se aplicara.
 */
export function createFlyWorkerMachines(options: FlyWorkerMachinesOptions): WorkerMachines {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/v1/apps/${encodeURIComponent(options.appName)}/machines`;
  const headers = { authorization: flyAuthorization(options.token), accept: "application/json" };

  async function call(what: string, url: string, method: "GET" | "POST"): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new FlyMachinesError(`la API de Machines de Fly no respondió al ${what}`, null, {
        cause: error,
      });
    }
    if (!response.ok) {
      // El cuerpo no se lee: podría repetir algo del pedido.
      await response.body?.cancel().catch(() => undefined);
      const hint =
        response.status === 401 || response.status === 403
          ? ": Fly no acepta FLY_WORKER_WAKE_TOKEN (créalo y guárdalo de nuevo, docs/10-despliegue.md)"
          : "";
      throw new FlyMachinesError(
        `la API de Machines de Fly respondió ${response.status} al ${what}${hint}`,
        response.status,
      );
    }
    return response;
  }

  return {
    async list() {
      const url = `${base}?metadata.fly_process_group=${FLY_WORKER_PROCESS_GROUP}`;
      const response = await call("listar las máquinas", url, "GET");
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        throw new FlyMachinesError(
          "la API de Machines de Fly respondió algo que no es una lista",
          null,
        );
      }
      return body.flatMap((item): WorkerMachine[] => {
        const machine = item as {
          id?: unknown;
          state?: unknown;
          config?: { metadata?: Record<string, unknown> };
        };
        if (typeof machine.id !== "string" || typeof machine.state !== "string") return [];
        if (machine.config?.metadata?.fly_process_group !== FLY_WORKER_PROCESS_GROUP) return [];
        return [{ id: machine.id, state: machine.state }];
      });
    },
    async start(id) {
      const response = await call(
        "encender el worker",
        `${base}/${encodeURIComponent(id)}/start`,
        "POST",
      );
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

/** Por qué hay que encender el worker (para el log). */
export type WakeReason = "enqueue" | "jobs" | "publications" | "maintenance";

export type NextWork = { at: Date; reason: Exclude<WakeReason, "enqueue"> };

/** Cuánto adelante mira por las programadas (una sola fila: la más temprana). */
export const NEXT_WORK_HORIZON_MS = 24 * 60 * 60_000;
/**
 * Sin trabajo, el worker se enciende igual una vez al día (desde su último latido): al arrancar
 * renueva los tokens, pide el respaldo si toca y sincroniza Portal (sus crons solo corren con él
 * encendido).
 */
export const MAINTENANCE_EVERY_MS = 24 * 60 * 60_000;

export type NextWorkDeps = {
  /** `nextPendingJobAt` de la cola, sin los jobs de fondo (`BACKGROUND_JOBS`). */
  pendingJobAt: () => Promise<Date | null>;
  publications: Pick<PublicationRepository, "listDue">;
  heartbeats: Pick<WorkerHeartbeatRepository, "listLatest">;
};

/**
 * Cuándo vence lo próximo que necesita al worker: un job (activo: ya), una programada que sale sola
 * (la regla del disparo, `dueQuery`: las vencidas de hace menos de 12 h cuentan como ya, sin las de
 * paso manual) o el mantenimiento diario. Sin ningún latido, el worker nunca corrió: ya.
 * Tres consultas de una fila.
 */
export function createNextWorkAt(deps: NextWorkDeps): (now: Date) => Promise<NextWork | null> {
  return async (now) => {
    const [latest] = await deps.heartbeats.listLatest(1);
    if (latest === undefined) return { at: now, reason: "maintenance" };
    const candidates: NextWork[] = [
      {
        at: new Date((latest.stoppedAt ?? latest.beatAt).getTime() + MAINTENANCE_EVERY_MS),
        reason: "maintenance",
      },
    ];
    const job = await deps.pendingJobAt();
    if (job !== null) candidates.push({ at: job, reason: "jobs" });
    const [due] = await deps.publications.listDue({
      ...dueQuery(now, NEXT_WORK_HORIZON_MS),
      limit: 1,
    });
    if (due?.scheduledAt) candidates.push({ at: due.scheduledAt, reason: "publications" });
    return candidates.reduce((first, next) => (next.at < first.at ? next : first));
  };
}

export type WorkerWakeOptions = {
  machines: WorkerMachines;
  nextWorkAt: (now: Date) => Promise<NextWork | null>;
  logger: Logger;
  now?: () => number;
  /** Cada cuánto mira el reloj en memoria (sin consultar nada). */
  tickMs?: number;
  /** Cuánto antes de la hora se enciende (arranque de la máquina y del worker). */
  leadMs?: number;
  /** Con el worker encendido, cada cuánto pregunta a Fly si sigue así (sin Neon). */
  watchMs?: number;
  /** Con el worker detenido, el máximo sin volver a consultar la base. */
  recheckMs?: number;
  /** Tras un pedido que escribe, en cuánto vuelve a revisar. */
  pokeDelayMs?: number;
  /** Con la máquina en un estado de paso (`stopping`, `replacing`…), en cuánto vuelve a mirar. */
  transitionMs?: number;
  errors?: { report(error: unknown): void; dispose(): void };
};

export type WorkerWake = {
  /** Hay trabajo ya (se encoló algo): enciende el worker si está detenido, sin consultar la base. */
  wake(reason: WakeReason): void;
  /** Algo cambió (un pedido que escribe, una programada nueva): revisa pronto. */
  poke(): void;
  stop(): void;
  /** Espera la revisión en curso (para los tests). */
  settled(): Promise<void>;
};

export const WORKER_WAKE_DEFAULTS = {
  tickMs: 15_000,
  leadMs: 5 * 60_000,
  watchMs: 2 * 60_000,
  recheckMs: 3 * 60 * 60_000,
  pokeDelayMs: 10_000,
  transitionMs: 30_000,
} as const;

/** El temporizador que enciende el worker (ver arriba). La primera revisión es al arrancar. */
export function startWorkerWake(options: WorkerWakeOptions): WorkerWake {
  const now = options.now ?? (() => Date.now());
  const settings = { ...WORKER_WAKE_DEFAULTS, ...definedOf(options) };
  const errors =
    options.errors ??
    createErrorThrottle(options.logger, "no se pudo revisar o encender el worker en Fly", {
      summaryEveryMs: 30 * 60_000,
      recoveredAfterMs: 3 * settings.watchMs,
    });
  let nextCheckAt = now();
  let wantStart: WakeReason | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let lastPlan = "";

  async function check(): Promise<void> {
    const t = now();
    const machines = await options.machines.list();
    if (machines.length === 0) {
      throw new FlyMachinesError("no hay una máquina del worker en la app de Fly", null);
    }
    if (machines.some((machine) => AWAKE_STATES.has(machine.state))) {
      wantStart = null;
      nextCheckAt = t + settings.watchMs;
      return;
    }
    const asleep = machines.filter((machine) => SLEEPING_STATES.has(machine.state));
    if (asleep.length < machines.length) {
      // Apagándose o reemplazándose: se mira de nuevo en un rato (y se enciende si quedó detenida).
      nextCheckAt = t + settings.transitionMs;
      return;
    }
    let reason = wantStart;
    if (reason === null) {
      const next = await options.nextWorkAt(new Date(t));
      if (next === null || next.at.getTime() - t > settings.leadMs) {
        const until =
          next === null ? Number.POSITIVE_INFINITY : next.at.getTime() - settings.leadMs;
        nextCheckAt = Math.min(t + settings.recheckMs, until);
        const plan = next === null ? "nada" : `${next.reason}@${next.at.toISOString()}`;
        if (plan !== lastPlan) {
          options.logger.debug(
            { next: next?.at.toISOString() ?? null, reason: next?.reason ?? null },
            "el worker está detenido y no hay nada por vencer todavía",
          );
          lastPlan = plan;
        }
        return;
      }
      reason = next.reason;
    }
    for (const machine of asleep) await options.machines.start(machine.id);
    options.logger.info(
      { reason, machines: asleep.map((machine) => machine.id) },
      "la API encendió el worker: hay trabajo",
    );
    wantStart = null;
    lastPlan = "";
    nextCheckAt = t + settings.watchMs;
  }

  function run(): void {
    if (stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = (async () => {
      try {
        await check();
      } catch (error) {
        errors.report(error);
        nextCheckAt = now() + settings.watchMs;
      } finally {
        running = null;
        if (again) {
          again = false;
          run();
        }
      }
    })();
  }

  const timer = setInterval(() => {
    if (now() >= nextCheckAt) run();
  }, settings.tickMs);
  timer.unref();
  run();

  return {
    wake(reason) {
      if (stopped) return;
      wantStart = reason;
      nextCheckAt = 0;
      run();
    },
    poke() {
      nextCheckAt = Math.min(nextCheckAt, now() + settings.pokeDelayMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      errors.dispose();
    },
    async settled() {
      while (running !== null) await running;
    },
  };
}

function definedOf(options: WorkerWakeOptions): Partial<typeof WORKER_WAKE_DEFAULTS> {
  const keys = Object.keys(WORKER_WAKE_DEFAULTS) as (keyof typeof WORKER_WAKE_DEFAULTS)[];
  return Object.fromEntries(
    keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
  );
}

/** Sin token o sin app (local, tests, otra instancia): no enciende nada. */
export const DISABLED_WORKER_WAKE: WorkerWake = {
  wake() {},
  poke() {},
  stop() {},
  async settled() {},
};

/**
 * El temporizador si están el token y el nombre de la app; si no, el que no hace nada, con un log
 * una sola vez (al arrancar la API).
 */
export function workerWakeFromEnv(
  env: {
    FLY_WORKER_WAKE_TOKEN?: string | undefined;
    FLY_APP_NAME?: string | undefined;
    FLY_MACHINES_API_URL: string;
  },
  deps: { nextWorkAt: WorkerWakeOptions["nextWorkAt"]; logger: Logger; fetch?: typeof fetch },
): WorkerWake {
  const token = env.FLY_WORKER_WAKE_TOKEN?.trim() ?? "";
  const appName = env.FLY_APP_NAME?.trim() ?? "";
  if (token === "" || appName === "") {
    deps.logger.info(
      { tokenConfigured: token !== "", appConfigured: appName !== "" },
      "la API no enciende el worker: falta FLY_WORKER_WAKE_TOKEN o FLY_APP_NAME (ADR-0044; sin ellos, el worker debe quedar encendido)",
    );
    return DISABLED_WORKER_WAKE;
  }
  deps.logger.info(
    { appName, apiUrl: env.FLY_MACHINES_API_URL },
    "la API enciende el worker cuando hay trabajo (ADR-0044)",
  );
  return startWorkerWake({
    machines: createFlyWorkerMachines({
      apiUrl: env.FLY_MACHINES_API_URL,
      appName,
      token,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    }),
    nextWorkAt: deps.nextWorkAt,
    logger: deps.logger,
  });
}

/**
 * La cola de la API que, después de encolar, enciende el worker: ya, o, si el job empieza más
 * adelante, revisa pronto (la revisión calcula cuándo encenderlo).
 */
export function wakingQueue(
  queue: JobQueue,
  wake: Pick<WorkerWake, "wake" | "poke">,
  { now = () => Date.now(), leadMs = WORKER_WAKE_DEFAULTS.leadMs } = {},
): JobQueue {
  return {
    async enqueue(name, data, options) {
      const id = await queue.enqueue(name, data, options);
      const startAfter = options?.startAfter?.getTime();
      if (startAfter !== undefined && startAfter - now() > leadMs) wake.poke();
      else wake.wake("enqueue");
      return id;
    },
  };
}

/** Un pedido que pudo crear o cambiar trabajo (no `GET` ni `HEAD`, y sin error). */
export function isWritingRequest(method: string, status: number): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && status < 400;
}
