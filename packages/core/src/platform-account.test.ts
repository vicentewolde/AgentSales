import { describe, expect, it } from "vitest";
import {
  checkConnectedCredentials,
  checkCredentials,
  MERCADOLIBRE_SITE_ID,
  marketplaceAccountMetaSchema,
  mercadoLibreAccountMetaSchema,
  usesSessionProfile,
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

  it("rechaza otro sitio, un vencimiento que no es estimado y una fecha que no es ISO", () => {
    expect(mercadoLibreAccountMetaSchema.safeParse({ ...meta, siteId: "MLA" }).success).toBe(false);
    expect(
      mercadoLibreAccountMetaSchema.safeParse({ ...meta, tokenExpiryEstimated: false }).success,
    ).toBe(false);
    expect(
      mercadoLibreAccountMetaSchema.safeParse({ ...meta, accessTokenExpiresAt: "en 6 horas" })
        .success,
    ).toBe(false);
  });
});

describe("cuentas sin credenciales (Marketplace, ADR-0017)", () => {
  it("solo Marketplace vive en un perfil del navegador", () => {
    expect(usesSessionProfile("fb_marketplace")).toBe(true);
    expect(usesSessionProfile("instagram")).toBe(false);
    expect(usesSessionProfile("portal_inmobiliario")).toBe(false);
  });

  it("Marketplace se conecta sin credenciales y nunca con ellas", () => {
    expect(checkConnectedCredentials("fb_marketplace", null)).toBeNull();
    expect(checkConnectedCredentials("fb_marketplace", undefined)).toBeNull();
    expect(() =>
      checkConnectedCredentials("fb_marketplace", { accessToken: "cookie-secreta" }),
    ).toThrow(
      expect.objectContaining({ code: "ACCOUNT_CREDENTIALS_NOT_ALLOWED", retriable: false }),
    );
  });

  it("las demás las exigen, válidas, sin el valor en el error", () => {
    expect(checkConnectedCredentials("instagram", { accessToken: "IGAA-token" })).toEqual({
      accessToken: "IGAA-token",
    });
    expect(() => checkConnectedCredentials("portal_inmobiliario", null)).toThrow(
      expect.objectContaining({ code: "ACCOUNT_CREDENTIALS_REQUIRED", retriable: false }),
    );
    let caught: unknown;
    try {
      checkConnectedCredentials("instagram", { accessToken: "", extra: "valor-secreto" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(JSON.stringify(caught)).not.toContain("valor-secreto");
  });
});

describe("meta de Marketplace", () => {
  const meta = {
    userId: "100012345678901",
    connectedAt: "2026-10-09T12:00:00.000Z",
    sessionCheckedAt: "2026-10-09T12:00:00.000Z",
  };

  it("acepta la cuenta conectada, con o sin el último error de inicio de sesión", () => {
    expect(marketplaceAccountMetaSchema.parse(meta)).toEqual(meta);
    const withError = {
      ...meta,
      lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: "2026-10-10T09:00:00.000Z" },
    };
    expect(marketplaceAccountMetaSchema.parse(withError)).toEqual(withError);
  });

  it.each([{ userId: "abc" }, { userId: "" }, { connectedAt: "ayer" }])("rechaza %o", (change) => {
    expect(marketplaceAccountMetaSchema.safeParse({ ...meta, ...change }).success).toBe(false);
  });
});
