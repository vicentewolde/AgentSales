import { describe, expect, it } from "vitest";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryJobQueue,
} from "../testing/index.js";
import { requestMarketplaceLogin } from "./request-marketplace-login.js";

const NOW = new Date("2026-10-10T12:00:00Z");

function setup() {
  const broker = contentBrokerFixture();
  const brokers = createInMemoryBrokerRepository([broker]);
  const queue = createInMemoryJobQueue();
  return { broker, brokers, queue };
}

describe("requestMarketplaceLogin (spec F5 §4.2)", () => {
  it("encola el login del corredor con la hora del pedido y el nombre, por corredor", async () => {
    const { broker, brokers, queue } = setup();

    const result = await requestMarketplaceLogin(
      { brokers, queue, now: () => NOW },
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
    await requestMarketplaceLogin({ brokers, queue }, { broker: broker.slug, label: "  " });
    expect(queue.jobs[0]?.data).not.toHaveProperty("label");
  });

  it("con otra acción del perfil en cola: MARKETPLACE_PROFILE_ACTION_PENDING", async () => {
    const { broker, brokers } = setup();
    await expect(
      requestMarketplaceLogin(
        { brokers, queue: { enqueue: async () => null } },
        { broker: broker.slug },
      ),
    ).rejects.toMatchObject({ code: "MARKETPLACE_PROFILE_ACTION_PENDING" });
  });

  it("un corredor que no existe: BROKER_NOT_FOUND, sin encolar", async () => {
    const { brokers, queue } = setup();
    await expect(
      requestMarketplaceLogin({ brokers, queue }, { broker: "no-existe" }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect(queue.jobs).toEqual([]);
  });
});
