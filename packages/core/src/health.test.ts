import { describe, expect, it } from "vitest";
import {
  brokersLiveNow,
  HEALTH_CHECK_NAMES,
  healthReportSchema,
  splitAutoPublish,
} from "./health.js";

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

describe("las marcas en vivo del reporte (F9.5-T22, ADR-0036)", () => {
  it("acepta liveBrokers (lista, null o ausente)", () => {
    expect(healthReportSchema.parse({ ...report, liveBrokers: ["a"] }).liveBrokers).toEqual(["a"]);
    expect(healthReportSchema.parse({ ...report, liveBrokers: null }).liveBrokers).toBeNull();
    expect(healthReportSchema.parse(report).liveBrokers).toBeUndefined();
  });

  it("brokersLiveNow: con el servidor en simulación ninguna; en live, las encendidas; sin lista, no se sabe", () => {
    expect(brokersLiveNow({ publishMode: "dry-run", liveBrokers: ["a"] })).toEqual([]);
    expect(brokersLiveNow({ publishMode: "live", liveBrokers: ["a"] })).toEqual(["a"]);
    expect(brokersLiveNow({ publishMode: "live", liveBrokers: [] })).toEqual([]);
    expect(brokersLiveNow({ publishMode: "live", liveBrokers: null })).toBeNull();
    expect(brokersLiveNow({ publishMode: "live" })).toBeNull();
  });

  it("splitAutoPublish: solo cuenta en vivo la marca encendida con el servidor en live; ante la duda, en vivo", () => {
    const auto = ["a", "b"];
    expect(
      splitAutoPublish({ publishMode: "live", liveBrokers: ["a"], autoPublishBrokers: auto }),
    ).toEqual({ live: ["a"], simulated: ["b"] });
    expect(
      splitAutoPublish({ publishMode: "dry-run", liveBrokers: ["a"], autoPublishBrokers: auto }),
    ).toEqual({ live: [], simulated: auto });
    expect(splitAutoPublish({ publishMode: "live", autoPublishBrokers: auto })).toEqual({
      live: auto,
      simulated: [],
    });
    expect(splitAutoPublish({ publishMode: "live", autoPublishBrokers: null })).toEqual({
      live: [],
      simulated: [],
    });
  });
});
