import { describe, expect, it } from "vitest";
import { checkQueueSchema, type Queryable } from "./schema-check.js";

describe("checkQueueSchema", () => {
  const withRows = (rows: unknown[]): Queryable => ({ execute: async () => ({ rows }) });

  it("pasa si existe el esquema de pg-boss", async () => {
    await expect(checkQueueSchema(withRows([{ "?column?": 1 }]))).resolves.toBeUndefined();
  });

  it("lanza QUEUE_UNAVAILABLE (reintentable) si el worker nunca arrancó", async () => {
    await expect(checkQueueSchema(withRows([]))).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      retriable: true,
      message: expect.stringContaining("arranca el worker"),
    });
  });
});
