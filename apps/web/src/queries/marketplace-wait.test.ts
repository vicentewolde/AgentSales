import {
  MARKETPLACE_CONFIRM_CLIENT_WAIT_MS,
  MARKETPLACE_LOGIN_CLIENT_WAIT_MS,
  MARKETPLACE_WAIT_MAX_POLL_FAILURES,
} from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { loginWaitStep } from "./accounts.js";
import { manualWaitDue } from "./publications.js";

// F5-T12 y T13: las esperas del panel, como funciones puras (sin relojes ni red).

describe("loginWaitStep (la espera del inicio de sesión)", () => {
  it("un resultado final termina la espera y reinicia las fallas", () => {
    expect(loginWaitStep({ result: { outcome: "connected" }, failures: 5, elapsedMs: 0 })).toEqual({
      wait: { outcome: "connected" },
      failures: 0,
    });
    expect(
      loginWaitStep({
        result: { outcome: "failed", code: "MARKETPLACE_LOGIN_TIMEOUT" },
        failures: 0,
        elapsedMs: 0,
      }).wait,
    ).toEqual({ outcome: "failed", code: "MARKETPLACE_LOGIN_TIMEOUT" });
  });

  it("sin resultado sigue esperando hasta el tope; después, timeout", () => {
    const pending = { outcome: "pending" } as const;
    expect(
      loginWaitStep({
        result: pending,
        failures: 0,
        elapsedMs: MARKETPLACE_LOGIN_CLIENT_WAIT_MS - 1,
      }).wait,
    ).toEqual(pending);
    expect(
      loginWaitStep({ result: pending, failures: 0, elapsedMs: MARKETPLACE_LOGIN_CLIENT_WAIT_MS })
        .wait,
    ).toEqual({ outcome: "timeout" });
  });

  it("cuenta las consultas fallidas seguidas: una buena las reinicia; al llegar al máximo, unreachable", () => {
    expect(loginWaitStep({ result: null, failures: 0, elapsedMs: 0 })).toEqual({
      wait: { outcome: "pending" },
      failures: 1,
    });
    expect(
      loginWaitStep({ result: { outcome: "pending" }, failures: 20, elapsedMs: 0 }).failures,
    ).toBe(0);
    expect(
      loginWaitStep({
        result: null,
        failures: MARKETPLACE_WAIT_MAX_POLL_FAILURES - 1,
        elapsedMs: 0,
      }).wait,
    ).toEqual({ outcome: "unreachable" });
  });
});

describe("manualWaitDue (relectura con la ventana abierta)", () => {
  it("solo con la pestaña a la vista y antes del tope de la ventana", () => {
    const ready = 1_000_000;
    expect(manualWaitDue(ready, ready + 5_000, true)).toBe(true);
    expect(manualWaitDue(ready, ready + 5_000, false)).toBe(false);
    expect(manualWaitDue(ready, ready + MARKETPLACE_CONFIRM_CLIENT_WAIT_MS, true)).toBe(false);
  });
});
