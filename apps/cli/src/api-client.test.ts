import { describe, expect, it } from "vitest";
import { apiUrl, createHealthFetcher } from "./api-client.js";

describe("api-client", () => {
  it("apunta a la API en IPv4 local", () => {
    expect(apiUrl(8787)).toBe("http://127.0.0.1:8787");
  });

  it("falla con un error claro si nadie escucha en el puerto", async () => {
    // Puerto 1: reservado y sin servicio; la conexión se rechaza de inmediato, sin red externa.
    await expect(createHealthFetcher(1, 2_000)()).rejects.toThrow();
  });
});
