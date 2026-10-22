import { createLogger } from "@agentsales/config";
import type { DueQuery, Platform, Publication } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countPendingJobs,
  createIdleProbe,
  type IdleReason,
  type QueueDb,
  startIdleExit,
} from "./idle-exit.js";

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
  function start(idleMinutes = 10) {
    const state: { reason: IdleReason | null | Error } = { reason: null };
    const margins: number[] = [];
    const onIdle = vi.fn();
    const idle = startIdleExit({
      idleMinutes,
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

  it("sin nada que hacer, cierra a los N minutos (una sola vez) y revisa con ese margen", async () => {
    const { onIdle, margins } = start(10);

    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(margins.every((margin) => margin === 10 * MINUTE)).toBe(true);

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

  it("si la revisión falla, no se sabe: no se apaga", async () => {
    const { state, onIdle } = start(10);
    state.reason = new Error("la base no respondió");

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
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

describe("countPendingJobs", () => {
  it("cuenta en la tabla de pg-boss los activos y los que empiezan dentro del margen, sin publication.due", async () => {
    const calls: { text: string; values?: unknown[] }[] = [];
    const db: QueueDb = {
      executeSql: async (text, values) => {
        calls.push({ text, ...(values === undefined ? {} : { values }) });
        return { rows: [{ count: 2 }] };
      },
    };

    expect(await countPendingJobs(db, 10 * MINUTE)).toBe(2);
    expect(calls[0]?.text).toContain("from pgboss.job");
    expect(calls[0]?.text).toContain("state = 'active'");
    expect(calls[0]?.text).toContain("state in ('created', 'retry')");
    expect(calls[0]?.values).toEqual([["publication.due"], 600]);
  });

  it("sin filas, 0", async () => {
    expect(await countPendingJobs({ executeSql: async () => ({ rows: [] }) }, MINUTE)).toBe(0);
  });
});
