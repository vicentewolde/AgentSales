import { describe, expect, it } from "vitest";
import type { PublishMode } from "./enums.js";
import {
  accountPublishMode,
  brokerLiveEnabled,
  brokerPublishMode,
  effectiveDryRun,
  effectivePublishMode,
  listingPublishMode,
  liveEnabledBrokers,
  liveModeMismatch,
  postPublishMode,
  publicationPublishMode,
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

describe("el modo por sujeto (la misma función para la API y el worker)", () => {
  const brokers = {
    findById: async (id: string) =>
      (
        ({
          on: { liveEnabled: true, operatorOwned: true },
          off: { liveEnabled: false, operatorOwned: true },
        }) as Record<string, unknown>
      )[id] as never,
  };
  const listings = { get: async (id: string) => (id === "x" ? null : ({ brokerId: id } as never)) };
  const posts = { get: async (id: string) => (id === "x" ? null : ({ brokerId: id } as never)) };
  const publications = {
    get: async (id: string) => (id === "x" ? null : ({ platformAccountId: id } as never)),
  };
  const platformAccounts = { get: async (id: string) => ({ brokerId: id }) as never };

  it("aviso, post, publicación y cuenta llegan a la marca y aplican las dos llaves", async () => {
    for (const [id, expected] of [
      ["on", "live"],
      ["off", "dry-run"],
      ["x", "dry-run"],
    ] as const) {
      expect(await listingPublishMode({ brokers, listings }, "live", id)).toBe(expected);
      expect(await postPublishMode({ brokers, posts }, "live", id)).toBe(expected);
      expect(
        await publicationPublishMode({ brokers, publications, platformAccounts }, "live", id),
      ).toBe(expected);
    }
    expect(await accountPublishMode({ brokers }, "live", { brokerId: "on" })).toBe("live");
    expect(await accountPublishMode({ brokers }, "live", null)).toBe("dry-run");
    expect(await listingPublishMode({ brokers, listings }, "dry-run", "on")).toBe("dry-run");
  });

  it("brokerLiveEnabled: encendida y propia", () => {
    expect(brokerLiveEnabled({ liveEnabled: true, operatorOwned: true })).toBe(true);
    expect(brokerLiveEnabled({ liveEnabled: true, operatorOwned: false })).toBe(false);
    expect(brokerLiveEnabled({ liveEnabled: false, operatorOwned: true })).toBe(false);
  });
});

describe("liveModeMismatch", () => {
  it("con el servidor en vivo dice que la marca está apagada y da las dos salidas", () => {
    const error = liveModeMismatch({
      what: "Esta publicación está en vivo",
      nothing: "no se cambió nada en la plataforma",
      serverMode: "live",
      portal: true,
      publicationId: "p1",
    });
    expect(error.code).toBe("PUBLISH_MODE_MISMATCH");
    expect(error.message).toContain("la marca está apagada");
    expect(error.message).toContain("agentsales brokers live <slug> on --confirm <slug>");
    expect(error.message).toContain(
      "ciérralo a mano en Mercado Libre y corre agentsales publications sync p1",
    );
    expect(error.details).toMatchObject({ cause: "brand_off", publicationId: "p1" });
  });

  it("con el servidor en simulación, el mensaje de siempre", () => {
    const error = liveModeMismatch({
      what: "Esta publicación está en vivo",
      nothing: "no se borró nada en la red",
      serverMode: "dry-run",
    });
    expect(error.message).toBe(
      "Esta publicación está en vivo, pero AgentSales está en simulación: no se borró nada en la red",
    );
    expect(error.details).toMatchObject({ cause: "server_dry_run" });
  });
});
