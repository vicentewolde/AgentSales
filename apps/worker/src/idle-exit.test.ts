import { createLogger } from "@agentsales/config";
import type { DueQuery, Platform, Publication } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleProbe, type IdleReason, pendingJobsOf, startIdleExit } from "./idle-exit.js";

// F9.5-T24 (ADR-0037): el worker se apaga solo cuando no tiene nada que hacer ni nada por vencer.

const T0 = new Date("2026-10-22T12:00:00.000Z");
const MINUTE = 60_000;
const logger = createLogger({ level: "silent" });

describe("startIdleExit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** El worker con una revisión que responde lo que diga `state.reason` en cada momento. */
  function start(idleMinutes = 10, stayAheadMinutes = 70) {
    const state: { reason: IdleReason | null | Error } = { reason: null };
    const margins: number[] = [];
    const onIdle = vi.fn();
    const idle = startIdleExit({
      idleMinutes,
      stayAheadMinutes,
      probe: async (marginMs) => {
        margins.push(marginMs);
        if (state.reason instanceof Error) throw state.reason;
        return state.reason;
      },
      onIdle,
      logger,
    });
    return { state, margins, onIdle, idle };
  }

  it("sin nada que hacer, cierra a los N minutos (una sola vez) y mira 70 min adelante", async () => {
    const { onIdle, margins } = start(10, 70);

    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(margins.length).toBeGreaterThan(0);
    expect(margins.every((margin) => margin === 70 * MINUTE)).toBe(true);

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("con un job activo no se apaga; terminado, cuenta N minutos desde ahí", async () => {
    const { state, onIdle } = start(10);
    state.reason = "jobs";

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();

    state.reason = null;
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("con una publicación por vencer no se apaga", async () => {
    const { state, onIdle } = start(10);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    state.reason = "publications";

    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("si la revisión falla, no se sabe: no se apaga, y el log no repite el error cada minuto", async () => {
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const { state, onIdle } = start(10);
    state.reason = new Error("la base no respondió");

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    // Un error al empezar y, como mucho, un resumen en esos 30 min (no 30 avisos).
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    error.mockRestore();
    warn.mockRestore();
  });

  it("con 0 minutos no arranca nada (nunca se apaga solo, como antes)", async () => {
    const { idle, onIdle, margins } = start(0);

    expect(idle).toBeNull();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    expect(margins).toEqual([]);
  });

  it("stop() deja de revisar (el apagado por una señal)", async () => {
    const { idle, onIdle } = start(10);

    idle?.stop();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("startIdleExit con la revisión real (WORKER_STAY_AHEAD_MINUTES = 70)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** El worker con una programada a `minutes` de T0, sin jobs. */
  function startWith(minutes: number) {
    const publication = {
      id: "pub",
      platform: "instagram",
      status: "scheduled",
      scheduledAt: new Date(T0.getTime() + minutes * MINUTE),
    } as Publication;
    const onIdle = vi.fn();
    startIdleExit({
      idleMinutes: 10,
      stayAheadMinutes: 70,
      probe: createIdleProbe({
        pendingJobs: async () => 0,
        publications: {
          listDue: async (query: DueQuery) =>
            (publication.scheduledAt?.getTime() ?? 0) <= query.now.getTime() &&
            (publication.scheduledAt?.getTime() ?? 0) >= query.since.getTime()
              ? [publication]
              : [],
        },
      }),
      onIdle,
      logger,
    });
    return onIdle;
  }

  it("se queda si algo vence en 60 minutos (y hasta que salga)", async () => {
    const onIdle = startWith(60);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("con 80 minutos ya lo ve a los 10 (70 de margen + 10 de espera): no se apaga", async () => {
    const onIdle = startWith(80);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("se apaga a los 10 minutos si, al apagarse, a lo próximo le faltan 80 (lo enciende la revisión siguiente)", async () => {
    // Vence a los 90 de T0: a los 10 min, cuando se apaga, le faltan 80, más que los 70 que mira.
    const onIdle = startWith(90);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe("createIdleProbe", () => {
  const NOW = T0;

  /** Una programada a `minutes` de NOW (solo lo que mira el probe). */
  const scheduled = (minutes: number, platform: Platform = "instagram") =>
    ({
      id: `pub-${minutes}-${platform}`,
      platform,
      status: "scheduled",
      scheduledAt: new Date(NOW.getTime() + minutes * MINUTE),
    }) as Publication;

  /** `listDue` como la consulta real: `since ≤ scheduled_at ≤ now`, sin las plataformas excluidas. */
  function publications(list: Publication[]) {
    return {
      listDue: async (query: DueQuery) =>
        list
          .filter(
            (publication) =>
              publication.scheduledAt !== null &&
              publication.scheduledAt.getTime() >= query.since.getTime() &&
              publication.scheduledAt.getTime() <= query.now.getTime() &&
              !query.excludePlatforms.includes(publication.platform),
          )
          .slice(0, query.limit),
    };
  }

  const probe = (list: Publication[], jobs = 0, windows = 0) =>
    createIdleProbe({
      pendingJobs: async () => jobs,
      publications: publications(list),
      openMarketplaceWindows: () => windows,
      now: () => NOW,
    })(10 * MINUTE);

  it("una publicación que vence dentro del margen, o que venció hace poco, lo mantiene encendido", async () => {
    expect(await probe([scheduled(9)])).toBe("publications");
    expect(await probe([scheduled(-30)])).toBe("publications");
  });

  it("no cuentan: lo que vence después del margen, lo atrasado más de 12 h ni un recordatorio de Marketplace", async () => {
    expect(
      await probe([scheduled(11), scheduled(-13 * 60), scheduled(-5, "fb_marketplace")]),
    ).toBeNull();
  });

  it("un job pendiente o un formulario de Marketplace abierto también", async () => {
    expect(await probe([], 1)).toBe("jobs");
    expect(await probe([], 0, 1)).toBe("marketplace_windows");
    expect(await probe([])).toBeNull();
  });
});

describe("pendingJobsOf", () => {
  it("pide a la cola los jobs del margen, sin publication.due ni publications.watch", async () => {
    const calls: unknown[][] = [];
    const count = pendingJobsOf({
      executeSql: async (_text, values) => {
        calls.push(values ?? []);
        return { rows: [{ count: 2 }] };
      },
    });

    expect(await count(70 * MINUTE)).toBe(2);
    expect(calls[0]).toEqual(["__pgboss__", ["publication.due", "publications.watch"], 4200]);
  });
});
