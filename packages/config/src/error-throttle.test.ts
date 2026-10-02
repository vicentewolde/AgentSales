import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorThrottle } from "./error-throttle.js";
import { createLogger } from "./logger.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    }),
  );
  return { logger, lines };
}

const offline = () =>
  Object.assign(new Error("getaddrinfo ENOTFOUND ep-test.neon.tech"), { code: "ENOTFOUND" });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createErrorThrottle", () => {
  it("registra el primer error completo y calla los repetidos dentro de la ventana", () => {
    const { logger, lines } = capture();
    const throttle = createErrorThrottle(logger, "error de pg-boss");

    for (let i = 0; i < 10; i++) {
      throttle.report(offline());
      vi.advanceTimersByTime(2_000);
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 50,
      msg: "error de pg-boss (se resumirá mientras siga ocurriendo)",
      err: { message: "getaddrinfo ENOTFOUND ep-test.neon.tech", code: "ENOTFOUND" },
    });
  });

  it("resume cada 30 s mientras la falla sigue", () => {
    const { logger, lines } = capture();
    const throttle = createErrorThrottle(logger, "error de pg-boss");

    throttle.report(offline());
    for (let i = 0; i < 16; i++) {
      vi.advanceTimersByTime(2_000);
      throttle.report(offline());
    }

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      level: 40,
      msg: "error de pg-boss: sigue ocurriendo",
      fallos: 15,
      desdeHaceS: 30,
      ultimo: "getaddrinfo ENOTFOUND ep-test.neon.tech",
    });
  });

  it("avisa cuando se recupera y la próxima falla vuelve a registrarse completa", () => {
    const { logger, lines } = capture();
    const throttle = createErrorThrottle(logger, "error de pg-boss");

    throttle.report(offline());
    vi.advanceTimersByTime(2_000);
    throttle.report(offline());
    vi.advanceTimersByTime(10_000);

    expect(lines.at(-1)).toMatchObject({
      level: 30,
      msg: "error de pg-boss: se recuperó",
      fallos: 2,
      duracionS: 12,
    });

    throttle.report(offline());
    expect(lines.at(-1)).toMatchObject({ level: 50, err: expect.any(Object) });
    expect(lines).toHaveLength(3);
  });

  it("dispose cancela el aviso de recuperación", () => {
    const { logger, lines } = capture();
    const throttle = createErrorThrottle(logger, "error de pg-boss");

    throttle.report(offline());
    throttle.dispose();
    vi.advanceTimersByTime(60_000);

    expect(lines).toHaveLength(1);
  });
});
