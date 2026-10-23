import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import { getDailyReadiness } from "./daily-readiness.js";

// La lista «Lista para publicar a diario» de una marca (F9.5-T27), leída de sus cuentas.

const ADMIN = { id: "admin", role: "admin" as const, brokerId: null };

async function setup() {
  const broker = contentBrokerFixture({ kind: "brand", slug: "agentpey", operatorOwned: true });
  const other = contentBrokerFixture({ id: "otra-marca", slug: "otra", kind: "brand" });
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const x = await platformAccounts.upsertConnected({
    brokerId: broker.id,
    platform: "x",
    externalAccountId: "cuenta-x",
    displayName: "@agentpey",
    tokenExpiresAt: null,
    meta: { spendLimitUsd: 3 },
    credentials: { accessToken: "token-prueba", refreshToken: "refresh-prueba" },
  });
  await platformAccounts.upsertConnected({
    brokerId: broker.id,
    platform: "linkedin",
    externalAccountId: "cuenta-linkedin",
    displayName: "Vinny",
    tokenExpiresAt: null,
    meta: { mode: "manual" },
    credentials: { accessToken: "token-prueba" },
  });
  const deps = {
    brokers: createInMemoryBrokerRepository([broker, other]),
    platformAccounts,
    publications: createInMemoryPublicationRepository(),
    contentRuns: createInMemoryContentRepositories().contentRuns,
    editorialProfiles: createInMemoryEditorialProfileRepository(),
    now: () => new Date("2026-10-22T15:00:00Z"),
  };
  return { broker, other, deps, x };
}

describe("getDailyReadiness", () => {
  it("arma la lista con las redes de la marca, su modo de cuenta y el tope de X", async () => {
    const s = await setup();
    const result = await getDailyReadiness(s.deps, ADMIN, {
      brokerId: s.broker.id,
      effectiveMode: "dry-run",
      server: "dry-run",
      workerSchedule: true,
    });
    expect(result.slug).toBe("agentpey");
    expect(result.networks.map((network) => network.platform)).toEqual(["x", "linkedin"]);
    const x = result.networks[0]?.items.find((item) => item.key === "x_spend");
    expect(x?.detail).toContain("US$ 0,00 de US$ 3,00");
    const linkedin = result.networks[1]?.items.find((item) => item.key === "entry_test");
    expect(linkedin?.state).toBe("ok");
    expect(result.brand.find((item) => item.key === "mode")?.state).toBe("missing");
  });

  it("una marca sin redes muestra todas las de los posts, para decir qué conectar", async () => {
    const s = await setup();
    const result = await getDailyReadiness(s.deps, ADMIN, {
      brokerId: s.other.id,
      effectiveMode: "dry-run",
      server: "dry-run",
      workerSchedule: null,
    });
    expect(result.networks.map((network) => network.platform)).toEqual([
      "instagram",
      "x",
      "linkedin",
      "discord",
      "tiktok",
    ]);
    expect(
      result.networks.every((network) => network.items[0]?.key === "account" && !network.ready),
    ).toBe(true);
  });

  it("la de otra marca no existe para un corredor", async () => {
    const s = await setup();
    const error = await getDailyReadiness(
      s.deps,
      { id: "u1", role: "broker", brokerId: s.other.id },
      { brokerId: s.broker.id, effectiveMode: "dry-run", server: "dry-run", workerSchedule: null },
    ).catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("BROKER_NOT_FOUND");
  });
});
