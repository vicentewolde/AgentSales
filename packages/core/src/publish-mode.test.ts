import { describe, expect, it } from "vitest";
import type { PublishMode } from "./enums.js";
import {
  brokerPublishMode,
  effectiveDryRun,
  effectivePublishMode,
  liveEnabledBrokers,
} from "./publish-mode.js";

// F9.5-T22 (ADR-0036): la tabla completa de las dos llaves y la condición de ser propio.

const TABLE: ReadonlyArray<{
  server: PublishMode;
  liveEnabled: boolean;
  operatorOwned: boolean;
  expected: PublishMode;
}> = [
  { server: "dry-run", liveEnabled: false, operatorOwned: false, expected: "dry-run" },
  { server: "dry-run", liveEnabled: false, operatorOwned: true, expected: "dry-run" },
  { server: "dry-run", liveEnabled: true, operatorOwned: false, expected: "dry-run" },
  { server: "dry-run", liveEnabled: true, operatorOwned: true, expected: "dry-run" },
  { server: "live", liveEnabled: false, operatorOwned: false, expected: "dry-run" },
  { server: "live", liveEnabled: false, operatorOwned: true, expected: "dry-run" },
  { server: "live", liveEnabled: true, operatorOwned: false, expected: "dry-run" },
  { server: "live", liveEnabled: true, operatorOwned: true, expected: "live" },
];

describe("effectivePublishMode", () => {
  it.each(TABLE)(
    "servidor $server · marca encendida $liveEnabled · propia $operatorOwned → $expected",
    ({ server, liveEnabled, operatorOwned, expected }) => {
      const broker = { liveEnabled, operatorOwned };
      expect(effectivePublishMode(server, broker)).toBe(expected);
      expect(effectiveDryRun(server, broker)).toBe(expected === "dry-run");
    },
  );
});

describe("brokerPublishMode", () => {
  const broker = { liveEnabled: true, operatorOwned: true };
  const brokers = (found: typeof broker | null) => ({ findById: async () => found as never });

  it("lee la marca por id y aplica las dos llaves", async () => {
    expect(await brokerPublishMode({ brokers: brokers(broker) }, "live", "b1")).toBe("live");
    expect(
      await brokerPublishMode(
        { brokers: brokers({ ...broker, liveEnabled: false }) },
        "live",
        "b1",
      ),
    ).toBe("dry-run");
  });

  it("con el servidor en simulación ni busca la marca", async () => {
    let looked = false;
    const spy = {
      findById: async () => {
        looked = true;
        return broker as never;
      },
    };
    expect(await brokerPublishMode({ brokers: spy }, "dry-run", "b1")).toBe("dry-run");
    expect(looked).toBe(false);
  });

  it("una marca que no existe es simulación", async () => {
    expect(await brokerPublishMode({ brokers: brokers(null) }, "live", "nadie")).toBe("dry-run");
  });
});

describe("liveEnabledBrokers", () => {
  it("deja las encendidas y propias, sin mirar el servidor", () => {
    const list = [
      { slug: "a", liveEnabled: true, operatorOwned: true },
      { slug: "b", liveEnabled: false, operatorOwned: true },
      { slug: "c", liveEnabled: true, operatorOwned: false },
    ];
    expect(liveEnabledBrokers(list).map((broker) => broker.slug)).toEqual(["a"]);
  });
});
