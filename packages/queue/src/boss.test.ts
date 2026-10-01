import { describe, expect, it } from "vitest";
import { createBoss, PRODUCER_QUEUE_CACHE_SECONDS } from "./boss.js";

describe("createBoss", () => {
  // Construir no conecta: solo valida la configuración (pg-boss la verifica en el constructor).
  it.each(["worker", "producer"] as const)(
    "la configuración de %s es válida para pg-boss",
    (role) => {
      expect(() =>
        createBoss({ connectionString: "postgres://localhost:5432/no-se-usa", role }),
      ).not.toThrow();
    },
  );

  it("el productor refresca su caché de colas una vez al día (el tope de pg-boss)", () => {
    expect(PRODUCER_QUEUE_CACHE_SECONDS).toBe(24 * 60 * 60);
  });
});
