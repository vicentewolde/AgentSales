import { randomUUID } from "node:crypto";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import {
  accountListResponseSchema,
  accountResponseSchema,
  errorBodySchema,
} from "../contracts/index.js";
import { adminApp, testDeps } from "../testing/index.js";

// Instagram a mano de una marca (F9.6-T02, ADR-0041).

function setup(kind: "brand" | "broker" = "brand") {
  const broker = contentBrokerFixture({ kind, slug: "agentpey" });
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  const app = adminApp(testDeps({ brokers, platformAccounts }));
  const activate = (body: Record<string, unknown>) =>
    app.request("/accounts/instagram/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, broker, platformAccounts, activate };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

describe("POST /accounts/instagram/manual (F9.6-T02)", () => {
  it("el administrador la activa (201): sin token, a mano y con el usuario limpio", async () => {
    const { app, activate } = setup();

    const response = await activate({ broker: "agentpey", handle: " @AgentPey " });

    expect(response.status).toBe(201);
    const { account } = accountResponseSchema.parse(await response.json());
    expect(account).toMatchObject({
      platform: "instagram",
      displayName: "@agentpey",
      status: "connected",
      publishingMode: "manual",
      tokenExpiresAt: null,
      permissions: null,
    });
    expect(account.connectedAt).not.toBeNull();
    const list = accountListResponseSchema.parse(await (await app.request("/accounts")).json());
    expect(list.accounts.map((item) => item.publishingMode)).toEqual(["manual"]);
  });

  it("el usuario inválido es 400 INSTAGRAM_HANDLE_INVALID y no crea nada", async () => {
    const { app, activate } = setup();

    for (const handle of ["", "con espacio", "a/b"]) {
      const response = await activate({ broker: "agentpey", handle });
      expect([response.status, (await errorOf(response)).code]).toEqual([
        400,
        "INSTAGRAM_HANDLE_INVALID",
      ]);
    }
    const list = accountListResponseSchema.parse(await (await app.request("/accounts")).json());
    expect(list.accounts).toEqual([]);
  });

  it("un corredor de propiedades es 409 ACCOUNT_MODE_NOT_SUPPORTED; uno que no existe, 404", async () => {
    const { activate } = setup("broker");
    const notBrand = await activate({ broker: "agentpey", handle: "agentpey" });
    expect([notBrand.status, (await errorOf(notBrand)).code]).toEqual([
      409,
      "ACCOUNT_MODE_NOT_SUPPORTED",
    ]);
    const missing = await activate({ broker: "nadie", handle: "agentpey" });
    expect([missing.status, (await errorOf(missing)).code]).toEqual([404, "BROKER_NOT_FOUND"]);
  });

  it("el cuerpo sin usuario o con campos de más es 400", async () => {
    const { activate } = setup();

    expect((await activate({ broker: "agentpey" })).status).toBe(400);
    expect((await activate({ broker: "agentpey", handle: "agentpey", extra: 1 })).status).toBe(400);
  });
});
