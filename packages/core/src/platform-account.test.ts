import { describe, expect, it } from "vitest";
import {
  checkCredentials,
  MERCADOLIBRE_SITE_ID,
  mercadoLibreAccountMetaSchema,
} from "./platform-account.js";

describe("credenciales", () => {
  it("Instagram guarda solo el token; Mercado Libre también el de renovar (ADR-0015)", () => {
    expect(checkCredentials({ accessToken: "IG-token" })).toEqual({ accessToken: "IG-token" });
    expect(checkCredentials({ accessToken: "APP_USR-a", refreshToken: "TG-b" })).toEqual({
      accessToken: "APP_USR-a",
      refreshToken: "TG-b",
    });
  });

  it("un token de renovar vacío es CREDENTIALS_INVALID, sin el valor en el error", () => {
    let error: unknown;
    try {
      checkCredentials({ accessToken: "APP_USR-secreto", refreshToken: "" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(JSON.stringify(error)).not.toContain("APP_USR-secreto");
  });
});

describe("meta de Mercado Libre", () => {
  const meta = {
    userId: "123456",
    nickname: "VINNYPRUEBAS",
    siteId: "MLC",
    userType: "normal",
    scopes: ["offline_access", "read", "write"],
    testUser: false,
    connectedAt: "2026-10-06T12:00:00.000Z",
    tokenRefreshedAt: null,
    accessTokenExpiresAt: "2026-10-06T18:00:00.000Z",
    tokenExpiryEstimated: true,
  };

  it("acepta la cuenta conectada en Chile", () => {
    expect(MERCADOLIBRE_SITE_ID).toBe("MLC");
    expect(mercadoLibreAccountMetaSchema.parse(meta)).toEqual(meta);
  });

  it("rechaza otro sitio y una fecha que no es ISO", () => {
    expect(mercadoLibreAccountMetaSchema.safeParse({ ...meta, siteId: "MLA" }).success).toBe(false);
    expect(
      mercadoLibreAccountMetaSchema.safeParse({ ...meta, accessTokenExpiresAt: "en 6 horas" })
        .success,
    ).toBe(false);
  });
});
