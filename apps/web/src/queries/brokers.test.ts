import { describe, expect, it } from "vitest";
import { publishModeOf } from "./brokers.js";

// F9.5-T22 (ADR-0036): el modo que el panel muestra para lo que no tiene modo fijado.

const brokers = [
  { id: "on", liveEnabled: true, operatorOwned: true },
  { id: "off", liveEnabled: false, operatorOwned: true },
  { id: "ajeno", liveEnabled: true, operatorOwned: false },
];

describe("publishModeOf", () => {
  it("el de la marca con el servidor en vivo", () => {
    expect(publishModeOf("live", brokers, "on")).toBe("live");
    expect(publishModeOf("live", brokers, "off")).toBe("dry-run");
    expect(publishModeOf("live", brokers, "ajeno")).toBe("dry-run");
  });

  it("con el servidor en simulación, siempre simulación", () => {
    expect(publishModeOf("dry-run", brokers, "on")).toBe("dry-run");
    expect(publishModeOf("dry-run", undefined, undefined)).toBe("dry-run");
  });

  it("sin saber la marca (o el servidor), no se dice nada", () => {
    expect(publishModeOf("live", brokers, undefined)).toBeUndefined();
    expect(publishModeOf("live", brokers, "otra")).toBeUndefined();
    expect(publishModeOf("live", undefined, "on")).toBeUndefined();
    expect(publishModeOf(undefined, brokers, "on")).toBeUndefined();
  });
});
