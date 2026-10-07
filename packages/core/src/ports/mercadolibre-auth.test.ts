import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { isMercadoLibreTokenRejected } from "./mercadolibre-auth.js";

describe("isMercadoLibreTokenRejected", () => {
  it("solo un ML_AUTH_INVALID con httpStatus 401: refrescar una vez y repetir", () => {
    expect(
      isMercadoLibreTokenRejected(
        new AppError("ML_AUTH_INVALID", "x", { details: { httpStatus: 401 } }),
      ),
    ).toBe(true);
  });

  it.each([
    new AppError("ML_AUTH_INVALID", "invalid_grant", {
      details: { httpStatus: 400, error: "invalid_grant" },
    }),
    new AppError("ML_AUTH_INVALID", "mal formado", { details: { reason: "token_malformed" } }),
    new AppError("ML_PERMISSION_DENIED", "403", { details: { httpStatus: 401 } }),
    new AppError("IG_AUTH_INVALID", "otra plataforma", { details: { httpStatus: 401 } }),
    new Error("ML_AUTH_INVALID"),
    null,
  ])("no lo es: %o", (error) => {
    expect(isMercadoLibreTokenRejected(error)).toBe(false);
  });
});
