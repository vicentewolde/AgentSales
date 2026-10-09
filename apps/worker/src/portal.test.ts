import type { PublishMediaItem } from "@agentsales/core";
import {
  createInMemoryMediaStorage,
  createInMemoryPlatformCatalogRepository,
} from "@agentsales/core/testing";
import type { MercadoLibreItem, MercadoLibreItems } from "@agentsales/publishers";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../test/content-fixture.js";
import { createWorkerPortal, readPictureFrom } from "./portal.js";

describe("Portal en el worker (F4-T18)", () => {
  it("el publisher tiene preflight (simulación) y las operaciones van sin envolver para el sync", () => {
    const { logger } = captureLogger();
    const portal = createWorkerPortal({
      catalogRepository: createInMemoryPlatformCatalogRepository(),
      storage: createInMemoryMediaStorage(),
      logger,
    });

    expect(portal.publisher.platform).toBe("portal_inmobiliario");
    expect(portal.publisher.formats).toEqual(["post"]);
    expect(portal.publisher.preflight).toBeTypeOf("function");
    const operations = portal.operationsFor("portal_inmobiliario");
    for (const name of ["pause", "resume", "close", "getStatus"] as const) {
      expect(operations?.[name]).toBeTypeOf("function");
    }
    expect(portal.operationsFor("instagram")).toBeUndefined();
  });

  it("las fotos se leen de R2 por su ruta", async () => {
    const storage = createInMemoryMediaStorage();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    await storage.put("brokers/b/listings/l/pi_4x3/1.jpg", bytes, "image/jpeg");
    const media: PublishMediaItem = {
      mediaId: "m-1",
      kind: "image",
      mime: "image/jpeg",
      storagePath: "brokers/b/listings/l/pi_4x3/1.jpg",
      url: "https://r2.example/firmada",
      bytes: bytes.length,
      width: 1440,
      height: 1080,
      durationS: null,
    };

    expect(await readPictureFrom(storage)(media)).toEqual(bytes);
  });

  it("el sync con las operaciones reales solo lee el ítem: nunca cambia nada en Mercado Libre", async () => {
    const { logger } = captureLogger();
    const calls: string[] = [];
    const refuse = async (): Promise<never> => {
      throw new Error("el sync no escribe");
    };
    const item: MercadoLibreItem = {
      id: "MLC1234567890",
      permalink: null,
      status: "active",
      subStatus: [],
      startTime: null,
      stopTime: null,
      expirationTime: null,
      lastUpdated: null,
      tags: [],
      listingSource: null,
      sellerCustomField: null,
      warnings: [],
    };
    const items: MercadoLibreItems = {
      create: refuse,
      setStatus: refuse,
      addDescription: refuse,
      hideAddress: refuse,
      getDescription: refuse,
      findBySellerCustomField: refuse,
      searchItems: refuse,
      getLastModeration: async () => {
        calls.push("getLastModeration");
        return null;
      },
      get: async () => {
        calls.push("get");
        return item;
      },
    };
    const portal = createWorkerPortal({
      catalogRepository: createInMemoryPlatformCatalogRepository(),
      storage: createInMemoryMediaStorage(),
      logger,
      clients: { items },
    });

    const status = await portal.operationsFor("portal_inmobiliario")?.getStatus?.(
      { externalId: "MLC1234567890", progress: null },
      {
        account: {
          id: "cuenta",
          brokerId: "corredor",
          platform: "portal_inmobiliario",
          externalAccountId: "8035443",
          displayName: "VICENTEWOLDE",
          status: "connected",
          tokenExpiresAt: null,
          meta: {},
          hasCredentials: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        accessToken: async () => "APP_USR-prueba",
      },
    );

    expect(status).toMatchObject({ status: "active" });
    expect(calls).toEqual(["get"]);
  });
});
