import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";

describe("AppError", () => {
  it("es un Error con código y valores por defecto", () => {
    const error = new AppError("IMPORT_INVALID_ROW");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe("IMPORT_INVALID_ROW");
    expect(error.message).toBe("IMPORT_INVALID_ROW");
    expect(error.retriable).toBe(false);
    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("guarda mensaje, reintento, detalles y causa", () => {
    const cause = new Error("429 Too Many Requests");
    const error = new AppError("PUBLISH_RATE_LIMITED", "Límite de Instagram", {
      retriable: true,
      details: { platform: "instagram", retryAfterSeconds: 60 },
      cause,
    });

    expect(error.message).toBe("Límite de Instagram");
    expect(error.retriable).toBe(true);
    expect(error.details).toEqual({ platform: "instagram", retryAfterSeconds: 60 });
    expect(error.cause).toBe(cause);
  });
});
