import { isTerminalImportRun, RUN_WAIT } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { pollStop } from "./run-poll.js";

describe("pollStop", () => {
  const createdAt = new Date(2026, 9, 2, 10, 0);
  const at = (ms: number) => createdAt.getTime() + ms;
  const stop = (status: "queued" | "running" | "failed", failures: number, ms: number) =>
    pollStop({ status, createdAt }, isTerminalImportRun, failures, at(ms));

  it("sigue mientras la corrida corre, sin fallas y antes de las 2 h", () => {
    expect(stop("running", 2, RUN_WAIT.maxWaitMs - 1)).toBeNull();
  });

  it("para tras 3 fallas seguidas o a las 2 h, y nunca en una corrida terminada", () => {
    expect(stop("queued", 3, 0)).toBe("failures");
    expect(stop("running", 0, RUN_WAIT.maxWaitMs)).toBe("max-wait");
    expect(stop("failed", 5, RUN_WAIT.maxWaitMs)).toBeNull();
  });
});
