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

  it("LinkedIn solo borra un post al retirarlo (F9-T19): no se pausa, reactiva ni cierra", () => {
    const linkedin = createApiOperations()("linkedin");
    expect(linkedin?.remove).toBeTypeOf("function");
    expect(linkedin?.pause).toBeUndefined();
    expect(linkedin?.close).toBeUndefined();
  });

  it("X solo borra un post al retirarlo (F9.5-T09); TikTok no tiene operaciones (D9)", () => {
    const operationsFor = createApiOperations();
    const x = operationsFor("x");
    expect(x?.remove).toBeTypeOf("function");
    expect(x?.pause).toBeUndefined();
    expect(x?.close).toBeUndefined();
    expect(operationsFor("tiktok")).toBeUndefined();
  });
});
