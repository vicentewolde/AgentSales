import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "./errors.js";

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

describe("isAppError", () => {
  it("reconoce instancias y copias de otra carga del módulo", () => {
    const fromOtherCopy = Object.assign(new Error("x"), {
      name: "AppError",
      code: "INVALID_TRANSITION",
      retriable: false,
    });

    expect(isAppError(new AppError("X"))).toBe(true);
    expect(isAppError(fromOtherCopy)).toBe(true);
  });

  it("rechaza errores comunes y objetos que solo lo imitan", () => {
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError({ name: "AppError", code: "X", retriable: false })).toBe(false);
    expect(isAppError(Object.assign(new Error("x"), { name: "AppError" }))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("AppError")).toBe(false);
  });
});
