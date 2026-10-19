import { describe, expect, it } from "vitest";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryJobQueue,
} from "../testing/index.js";
import { requestMarketplaceLogin } from "./request-marketplace-login.js";

const NOW = new Date("2026-10-10T12:00:00Z");

function setup() {
  const broker = contentBrokerFixture({ operatorOwned: true });
  const brokers = createInMemoryBrokerRepository([broker]);
  const queue = createInMemoryJobQueue();
  return { broker, brokers, queue };
}

describe("requestMarketplaceLogin (spec F5 §4.2)", () => {
  it("encola el login del corredor con la hora del pedido y el nombre, por corredor", async () => {
    const { broker, brokers, queue } = setup();

    const result = await requestMarketplaceLogin(
      { brokers, queue, marketplaceAutomation: true, now: () => NOW },
      { broker: broker.slug, label: "  Facebook de Ana  " },
    );

    expect(result).toEqual({ brokerId: broker.id, requestedAt: NOW });
    expect(queue.jobs).toEqual([
      {
        name: "marketplace.profile",
        data: {
          brokerId: broker.id,
          action: "login",
          requestedAt: NOW.toISOString(),
          label: "Facebook de Ana",
        },
        options: { singletonKey: broker.id },
      },
    ]);
  });

  it("sin nombre (o vacío) no manda label", async () => {
    const { broker, brokers, queue } = setup();
    await requestMarketplaceLogin(
      { brokers, queue, marketplaceAutomation: true },
      { broker: broker.slug, label: "  " },
    );
    expect(queue.jobs[0]?.data).not.toHaveProperty("label");
  });

  it("con otra acción del perfil en cola: MARKETPLACE_PROFILE_ACTION_PENDING", async () => {
    const { broker, brokers } = setup();
    await expect(
      requestMarketplaceLogin(
        { brokers, queue: { enqueue: async () => null }, marketplaceAutomation: true },
        { broker: broker.slug },
      ),
    ).rejects.toMatchObject({ code: "MARKETPLACE_PROFILE_ACTION_PENDING" });
  });

  it("un corredor que no existe: BROKER_NOT_FOUND, sin encolar", async () => {
    const { brokers, queue } = setup();
    await expect(
      requestMarketplaceLogin(
        { brokers, queue, marketplaceAutomation: true },
        { broker: "no-existe" },
      ),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(queue.jobs).toEqual([]);
  });
});

describe("requestMarketplaceLogin · solo corredores propios (F7-T15, ADR-0023)", () => {
  it("un corredor que no es propio: MARKETPLACE_AUTOMATION_NOT_ALLOWED, sin encolar nada", async () => {
    const broker = contentBrokerFixture();
    const queue = createInMemoryJobQueue();
    await expect(
      requestMarketplaceLogin(
        { brokers: createInMemoryBrokerRepository([broker]), queue, marketplaceAutomation: true },
        { broker: broker.slug },
      ),
    ).rejects.toMatchObject({ code: "MARKETPLACE_AUTOMATION_NOT_ALLOWED" });
    expect(queue.jobs).toHaveLength(0);
  });
});

describe("requestMarketplaceLogin · en producción (F8-T20, D4)", () => {
  it("ni un corredor propio abre Facebook allí: MARKETPLACE_AUTOMATION_NOT_ALLOWED, sin encolar nada", async () => {
    const { broker, brokers, queue } = setup();
    await expect(
      requestMarketplaceLogin(
        { brokers, queue, marketplaceAutomation: false },
        { broker: broker.slug },
      ),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_AUTOMATION_NOT_ALLOWED",
      message: expect.stringContaining("En el servidor Marketplace se publica a mano"),
    });
    expect(queue.jobs).toEqual([]);
  });
});
