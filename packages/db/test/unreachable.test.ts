import { describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { createFieldDefinitionRepository } from "../src/repositories/field-definitions.js";

// Sin red externa: el puerto 1 de 127.0.0.1 rechaza la conexión al instante. Valida la forma real
// del error (DrizzleQueryError → Error de sistema con `code = ECONNREFUSED`), no una armada a mano.
describe("repositorio con la base inalcanzable (node-postgres real)", () => {
  it("responde DB_UNAVAILABLE reintentable", async () => {
    const { db, close } = createDb("postgresql://agentsales:x@127.0.0.1:1/agentsales");
    try {
      const repo = createFieldDefinitionRepository(db);
      await expect(repo.list({ category: "real_estate", brokerId: null })).rejects.toMatchObject({
        code: "DB_UNAVAILABLE",
        retriable: true,
      });
    } finally {
      await close();
    }
  });
});
