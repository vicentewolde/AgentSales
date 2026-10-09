import { createMercadoLibreItems, type MercadoLibreHttpOptions } from "@agentsales/publishers";
import { describe, expect, it } from "vitest";
import { createApiOperations } from "./portal.js";

describe("createApiOperations (F4-T19)", () => {
  it("arma las de Portal con un tope de 10 s por llamada y ninguna para otra plataforma", () => {
    const seen: MercadoLibreHttpOptions[] = [];
    const operationsFor = createApiOperations((options) => {
      seen.push(options);
      return createMercadoLibreItems(options);
    });

    expect(seen).toEqual([{ timeoutMs: 10_000 }]);
    const portal = operationsFor("portal_inmobiliario");
    for (const name of ["pause", "resume", "close", "getStatus"] as const) {
      expect(portal?.[name]).toBeTypeOf("function");
    }
    expect(operationsFor("instagram")).toBeUndefined();
  });
});
