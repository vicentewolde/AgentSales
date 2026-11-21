import type { Logger } from "@agentsales/config";
import type { JobQueue, Publication, WorkerHeartbeat } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFlyWorkerMachines,
  createNextWorkAt,
  DISABLED_WORKER_WAKE,
  FlyMachinesError,
  flyAuthorization,
  isWritingRequest,
  MAINTENANCE_EVERY_MS,
  type NextWork,
  startWorkerWake,
  type WorkerMachine,
  type WorkerWake,
  wakingQueue,
  workerWakeFromEnv,
} from "./worker-wake.js";

// ADR-0044: la API enciende el worker detenido. Nada habla con Fly: un `fetch` falso y fakes.

const MINUTE = 60_000;
const TOKEN = "FlyV1 fm2_token-inventado-de-prueba";

function fakeLogger() {
  const calls: { level: string; args: unknown[] }[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push({ level, args });
  const logger = {
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, calls };
}

type FetchCall = { url: string; method: string; authorization: string | null };

function fakeFetch(responder: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fn, calls };
}

const machine = (id: string, state: string, group = "worker") => ({
  id,
  state,
  config: { metadata: { fly_process_group: group } },
});

describe("createFlyWorkerMachines (API de Machines, con un fetch falso)", () => {
  it("lista solo las del grupo worker, con el token tal cual y el filtro en la consulta", async () => {
    const fetch = fakeFetch(() =>
      Response.json([machine("w1", "stopped"), machine("a1", "started", "api"), { id: 3 }]),
    );
    const machines = createFlyWorkerMachines({
      apiUrl: "http://_api.internal:4280/",
      appName: "agentsales",
      token: TOKEN,
      fetch: fetch.fn,
    });
    expect(await machines.list()).toEqual([{ id: "w1", state: "stopped" }]);
    expect(fetch.calls).toEqual([
      {
        url: "http://_api.internal:4280/v1/apps/agentsales/machines?metadata.fly_process_group=worker",
        method: "GET",
        authorization: TOKEN,
      },
    ]);
  });

  it("enciende con POST a /start", async () => {
    const fetch = fakeFetch(() => Response.json({ previous_state: "stopped" }));
    const machines = createFlyWorkerMachines({
      apiUrl: "https://api.machines.dev",
      appName: "agentsales",
      token: "sin-prefijo",
      fetch: fetch.fn,
    });
    await machines.start("w1");
    expect(fetch.calls).toEqual([
      {
        url: "https://api.machines.dev/v1/apps/agentsales/machines/w1/start",
        method: "POST",
        authorization: "Bearer sin-prefijo",
      },
    ]);
  });

  it("un rechazo dice el estado y qué hacer, sin el token ni el cuerpo", async () => {
    const fetch = fakeFetch(() => new Response(`token ${TOKEN} inválido`, { status: 401 }));
    const machines = createFlyWorkerMachines({
      apiUrl: "http://_api.internal:4280",
      appName: "agentsales",
      token: TOKEN,
      fetch: fetch.fn,
    });
    const error = await machines.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlyMachinesError);
    expect((error as FlyMachinesError).status).toBe(401);
    expect((error as Error).message).toContain("FLY_WORKER_WAKE_TOKEN");
    expect((error as Error).message).not.toContain("fm2_");
  });

  it("si Fly no responde, un error propio", async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const machines = createFlyWorkerMachines({
      apiUrl: "http://_api.internal:4280",
      appName: "agentsales",
      token: TOKEN,
      fetch: fetch.fn,
    });
    await expect(machines.start("w1")).rejects.toThrow(/no respondió al encender el worker/);
  });

  it("flyAuthorization", () => {
    expect(flyAuthorization(" FlyV1 fm2_x ")).toBe("FlyV1 fm2_x");
    expect(flyAuthorization("abc")).toBe("Bearer abc");
  });
});

describe("createNextWorkAt", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const beat = (at: Date, stoppedAt: Date | null = null): WorkerHeartbeat => ({
    processId: "p1",
    startedAt: at,
    beatAt: at,
    stoppedAt,
  });
  const scheduled = (at: Date) => ({ scheduledAt: at }) as Publication;

  function deps(over: { heartbeats?: WorkerHeartbeat[]; job?: Date | null; due?: Publication[] }) {
    const listDue = vi.fn(async () => over.due ?? []);
    return {
      listDue,
      next: createNextWorkAt({
        pendingJobAt: async () => over.job ?? null,
        publications: { listDue },
        heartbeats: { listLatest: async () => over.heartbeats ?? [beat(now)] },
      }),
    };
  }

  it("sin latidos (el worker nunca corrió), ya", async () => {
    expect(await deps({ heartbeats: [] }).next(now)).toEqual({ at: now, reason: "maintenance" });
  });

  it("sin nada, el mantenimiento a las 24 h del último apagado", async () => {
    const stopped = new Date(now.getTime() - 60 * MINUTE);
    const result = await deps({ heartbeats: [beat(stopped, stopped)] }).next(now);
    expect(result).toEqual({
      at: new Date(stopped.getTime() + MAINTENANCE_EVERY_MS),
      reason: "maintenance",
    });
  });

  it("lo más temprano entre un job y una programada; la programada con la regla del disparo", async () => {
    const job = new Date(now.getTime() + 90 * MINUTE);
    const due = new Date(now.getTime() + 30 * MINUTE);
    const { next, listDue } = deps({ job, due: [scheduled(due)] });
    expect(await next(now)).toEqual({ at: due, reason: "publications" });
    const query = listDue.mock.calls[0] as unknown as [{ since: Date; limit: number }];
    expect(query[0].limit).toBe(1);
    expect(query[0].since.getTime()).toBe(now.getTime() - 12 * 60 * MINUTE);
    expect(
      await deps({ job, due: [scheduled(new Date(job.getTime() + MINUTE))] }).next(now),
    ).toEqual({ at: job, reason: "jobs" });
  });
});

describe("startWorkerWake (con relojes falsos)", () => {
  let states: string[];
  let started: string[];
  let listCalls: number;
  let failList: Error | null;
  let nextWork: NextWork | null;
  let nextWorkCalls: number;
  let wake: WorkerWake | null;
  let reported: unknown[];

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-21T12:00:00Z") });
    states = ["stopped"];
    started = [];
    listCalls = 0;
    failList = null;
    nextWork = null;
    nextWorkCalls = 0;
    wake = null;
    reported = [];
  });
  afterEach(() => {
    wake?.stop();
    vi.useRealTimers();
  });

  function start() {
    const { logger, calls } = fakeLogger();
    wake = startWorkerWake({
      machines: {
        async list(): Promise<WorkerMachine[]> {
          listCalls++;
          if (failList) throw failList;
          return states.map((state, index) => ({ id: `w${index + 1}`, state }));
        },
        async start(id) {
          started.push(id);
          states = states.map(() => "started");
        },
      },
      nextWorkAt: async () => {
        nextWorkCalls++;
        return nextWork;
      },
      logger,
      errors: { report: (error) => reported.push(error), dispose: () => undefined },
    });
    return { wake, calls };
  }

  const inMinutes = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

  it("al arrancar, con el worker detenido y algo vencido, lo enciende", async () => {
    nextWork = { at: inMinutes(-1), reason: "publications" };
    const { wake, calls } = start();
    await wake.settled();
    expect(started).toEqual(["w1"]);
    expect(calls.some((c) => c.level === "info" && String(c.args[1]).includes("encendió"))).toBe(
      true,
    );
  });

  it("con lo próximo lejos, no lo enciende ni vuelve a consultar la base hasta la hora menos el margen", async () => {
    nextWork = { at: inMinutes(60), reason: "publications" };
    const { wake } = start();
    await wake.settled();
    expect(started).toEqual([]);
    expect(nextWorkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(nextWorkCalls).toBe(1);
    expect(listCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await wake.settled();
    expect(started).toEqual(["w1"]);
    expect(nextWorkCalls).toBe(2);
  });

  it("sin nada, vuelve a mirar la base como mucho cada 3 h", async () => {
    const { wake } = start();
    await wake.settled();
    await vi.advanceTimersByTimeAsync(179 * MINUTE);
    expect(nextWorkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await wake.settled();
    expect(nextWorkCalls).toBe(2);
    expect(started).toEqual([]);
  });

  it("con el worker encendido solo pregunta a Fly, sin consultar la base", async () => {
    states = ["started"];
    const { wake } = start();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    await wake.settled();
    expect(nextWorkCalls).toBe(0);
    expect(listCalls).toBeGreaterThanOrEqual(15);
    expect(started).toEqual([]);
  });

  it("cuando el worker se apaga solo, consulta la base una vez", async () => {
    states = ["started"];
    const { wake } = start();
    await wake.settled();
    states = ["stopped"];
    nextWork = { at: inMinutes(120), reason: "jobs" };
    await vi.advanceTimersByTimeAsync(2 * MINUTE + 15_000);
    await wake.settled();
    expect(nextWorkCalls).toBe(1);
    expect(started).toEqual([]);
  });

  it("wake enciende sin consultar la base", async () => {
    nextWork = { at: inMinutes(600), reason: "maintenance" };
    const { wake } = start();
    await wake.settled();
    wake.wake("enqueue");
    await wake.settled();
    expect(started).toEqual(["w1"]);
    expect(nextWorkCalls).toBe(1);
  });

  it("con la máquina apagándose, espera y la enciende cuando queda detenida", async () => {
    nextWork = { at: inMinutes(600), reason: "maintenance" };
    states = ["stopping"];
    const { wake } = start();
    await wake.settled();
    wake.wake("enqueue");
    await wake.settled();
    expect(started).toEqual([]);
    states = ["stopped"];
    await vi.advanceTimersByTimeAsync(45_000);
    await wake.settled();
    expect(started).toEqual(["w1"]);
  });

  it("poke adelanta la revisión de la base", async () => {
    nextWork = { at: inMinutes(600), reason: "maintenance" };
    const { wake } = start();
    await wake.settled();
    nextWork = { at: inMinutes(2), reason: "publications" };
    wake.poke();
    await vi.advanceTimersByTimeAsync(30_000);
    await wake.settled();
    expect(started).toEqual(["w1"]);
  });

  it("si Fly falla, lo informa resumido, no lanza y reintenta", async () => {
    failList = new FlyMachinesError("la API de Machines de Fly respondió 401", 401);
    nextWork = { at: inMinutes(-1), reason: "jobs" };
    const { wake } = start();
    await wake.settled();
    expect(reported).toHaveLength(1);
    failList = null;
    await vi.advanceTimersByTimeAsync(2 * MINUTE + 15_000);
    await wake.settled();
    expect(started).toEqual(["w1"]);
  });

  it("stop detiene todo", async () => {
    const { wake } = start();
    await wake.settled();
    wake.stop();
    const before = listCalls;
    wake.wake("enqueue");
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    expect(listCalls).toBe(before);
  });
});

describe("wakingQueue", () => {
  const queue: JobQueue = { enqueue: vi.fn(async () => "job-1") };

  it("encolar ya enciende; un job para más adelante solo adelanta la revisión", async () => {
    const wake = { wake: vi.fn(), poke: vi.fn() };
    const now = Date.parse("2026-11-21T12:00:00Z");
    const waking = wakingQueue(queue, wake, { now: () => now });
    expect(await waking.enqueue("content.plan", { planId: "p1" } as never)).toBe("job-1");
    expect(wake.wake).toHaveBeenCalledWith("enqueue");
    await waking.enqueue("content.plan", { planId: "p1" } as never, {
      startAfter: new Date(now + 60 * MINUTE),
    });
    expect(wake.poke).toHaveBeenCalledTimes(1);
    expect(wake.wake).toHaveBeenCalledTimes(1);
  });

  it("si encolar falla, no enciende", async () => {
    const wake = { wake: vi.fn(), poke: vi.fn() };
    const failing: JobQueue = {
      enqueue: async () => {
        throw new Error("cola caída");
      },
    };
    await expect(
      wakingQueue(failing, wake).enqueue("content.plan", { planId: "p1" } as never),
    ).rejects.toThrow("cola caída");
    expect(wake.wake).not.toHaveBeenCalled();
  });
});

describe("workerWakeFromEnv", () => {
  it("sin token o sin app no enciende nada y lo dice una vez, sin el token", () => {
    const { logger, calls } = fakeLogger();
    const result = workerWakeFromEnv(
      { FLY_APP_NAME: "agentsales", FLY_MACHINES_API_URL: "http://_api.internal:4280" },
      { nextWorkAt: async () => null, logger },
    );
    expect(result).toBe(DISABLED_WORKER_WAKE);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.args[1])).toContain("FLY_WORKER_WAKE_TOKEN");
    const other = fakeLogger();
    expect(
      workerWakeFromEnv(
        { FLY_WORKER_WAKE_TOKEN: TOKEN, FLY_MACHINES_API_URL: "http://_api.internal:4280" },
        { nextWorkAt: async () => null, logger: other.logger },
      ),
    ).toBe(DISABLED_WORKER_WAKE);
    expect(JSON.stringify(other.calls)).not.toContain("fm2_");
  });

  it("con los dos, arranca y no loguea el token", async () => {
    vi.useFakeTimers();
    try {
      const { logger, calls } = fakeLogger();
      const fetch = fakeFetch(() => Response.json([machine("w1", "started")]));
      const result = workerWakeFromEnv(
        {
          FLY_WORKER_WAKE_TOKEN: TOKEN,
          FLY_APP_NAME: "agentsales",
          FLY_MACHINES_API_URL: "http://_api.internal:4280",
        },
        { nextWorkAt: async () => null, logger, fetch: fetch.fn },
      );
      expect(result).not.toBe(DISABLED_WORKER_WAKE);
      await result.settled();
      expect(fetch.calls).toHaveLength(1);
      expect(JSON.stringify(calls)).not.toContain("fm2_");
      result.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isWritingRequest", () => {
  it("solo los que escriben y salieron bien", () => {
    expect(isWritingRequest("POST", 201)).toBe(true);
    expect(isWritingRequest("PATCH", 200)).toBe(true);
    expect(isWritingRequest("POST", 409)).toBe(false);
    expect(isWritingRequest("GET", 200)).toBe(false);
    expect(isWritingRequest("HEAD", 200)).toBe(false);
  });
});
