import { describe, expect, it } from "vitest";
import { createDb, toPgConnectionString } from "./client.js";

describe("toPgConnectionString", () => {
  it("fija sslmode=verify-full para mantener la verificación del certificado", () => {
    const url = toPgConnectionString(
      "postgresql://owner:fake%40pass@ep-test.sa-east-1.aws.neon.tech/neondb?sslmode=require",
    );

    expect(url).toBe(
      "postgresql://owner:fake%40pass@ep-test.sa-east-1.aws.neon.tech/neondb?sslmode=verify-full",
    );
  });

  it("no toca otros modos ni otros parámetros", () => {
    const url = "postgresql://o:p@ep-test.neon.tech/db?sslmode=verify-full&application_name=x";

    expect(toPgConnectionString(url)).toBe(url);
  });
});

describe("createDb", () => {
  it("registra un listener de errores del pool para que el proceso no se caiga", async () => {
    const errors: Error[] = [];
    const { db, close } = createDb("postgresql://o:p@localhost:1/db?sslmode=require", {
      onError: (error) => errors.push(error),
    });
    const pool = db.$client;

    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("error", new Error("conexión inactiva cerrada"));
    expect(errors.map((error) => error.message)).toEqual(["conexión inactiva cerrada"]);

    await close();
  });

  it("no se cae sin onError", async () => {
    const { db, close } = createDb("postgresql://o:p@localhost:1/db?sslmode=require");

    expect(() => db.$client.emit("error", new Error("x"))).not.toThrow();

    await close();
  });
});
