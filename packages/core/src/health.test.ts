import { describe, expect, it } from "vitest";
import { HEALTH_CHECK_NAMES, healthReportSchema } from "./health.js";

const report = {
  status: "degraded",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: false, latencyMs: 12, error: "R2 no respondió" },
    queue: { ok: true, latencyMs: 65 },
  },
};

describe("healthReportSchema", () => {
  it("acepta un informe válido", () => {
    expect(healthReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    ["otro estado", { ...report, status: "roto" }],
    ["otro modo", { ...report, publishMode: "real" }],
    ["un check faltante", { ...report, checks: { db: report.checks.db } }],
    ["otra cosa", { hola: "mundo" }],
  ])("rechaza %s", (_label, value) => {
    expect(healthReportSchema.safeParse(value).success).toBe(false);
  });

  it("los checks son db, storage y queue", () => {
    expect(HEALTH_CHECK_NAMES).toEqual(Object.keys(report.checks));
  });
});
