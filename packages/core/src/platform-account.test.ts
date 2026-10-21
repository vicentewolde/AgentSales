import { describe, expect, it } from "vitest";
import { PLATFORMS } from "./enums.js";
import {
  accessTokenOf,
  accountTokenNeverExpires,
  checkConnectedCredentials,
  checkCredentials,
  checkTokenExpiry,
  discordAccountMetaSchema,
  discordWebhookParts,
  hasAccessToken,
  instagramAccountMetaSchema,
  isManualMarketplaceAccount,
  MERCADOLIBRE_SITE_ID,
  marketplaceAccountMetaSchema,
  mercadoLibreAccountMetaSchema,
  PLATFORM_CREDENTIALS_SCHEMAS,
  platformCredentialsSchema,
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

describe("credenciales por plataforma (spec F9 §4.7)", () => {
  const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/token-falso_de-prueba";

  const errorOf = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (caught) {
      return caught;
    }
    return undefined;
  };

  it("cada plataforma acepta su variante", () => {
    expect(checkCredentials({ accessToken: "IG-token" }, "instagram")).toEqual({
      accessToken: "IG-token",
    });
    expect(checkCredentials({ accessToken: "LI-token" }, "linkedin")).toEqual({
      accessToken: "LI-token",
    });
    // Mercado Libre como hasta F8: el de renovar sigue opcional para leer las cuentas guardadas.
    expect(checkCredentials({ accessToken: "APP_USR-a" }, "portal_inmobiliario")).toEqual({
      accessToken: "APP_USR-a",
    });
    expect(
      checkCredentials({ accessToken: "APP_USR-a", refreshToken: "TG-b" }, "portal_inmobiliario"),
    ).toEqual({ accessToken: "APP_USR-a", refreshToken: "TG-b" });
    for (const platform of ["x", "tiktok"] as const) {
      expect(checkCredentials({ accessToken: "a", refreshToken: "r" }, platform)).toEqual({
        accessToken: "a",
        refreshToken: "r",
      });
    }
    expect(checkCredentials({ webhookUrl: WEBHOOK }, "discord")).toEqual({ webhookUrl: WEBHOOK });
  });

  it("X y TikTok exigen el token de renovar; Discord, el webhook; las de token, el token", () => {
    for (const [platform, credentials] of [
      ["x", { accessToken: "a" }],
      ["tiktok", { accessToken: "a" }],
      ["discord", { accessToken: "a" }],
      ["instagram", { webhookUrl: WEBHOOK }],
      ["linkedin", { webhookUrl: WEBHOOK }],
      ["portal_inmobiliario", { webhookUrl: WEBHOOK }],
      ["fb_marketplace", { accessToken: "a" }],
    ] as const) {
      expect(() => checkCredentials(credentials, platform)).toThrow(
        expect.objectContaining({ code: "CREDENTIALS_INVALID", retriable: false }),
      );
    }
  });

  it("acepta solo la URL https de un webhook de discord.com o discordapp.com, sin el valor en el error", () => {
    expect(
      checkCredentials(
        { webhookUrl: "https://discordapp.com/api/webhooks/1/abc_DEF-123" },
        "discord",
      ),
    ).toEqual({ webhookUrl: "https://discordapp.com/api/webhooks/1/abc_DEF-123" });
    for (const webhookUrl of [
      "http://discord.com/api/webhooks/1/token-secreto",
      "https://discord.com.evil.test/api/webhooks/1/token-secreto",
      "https://evil.test/discord.com/api/webhooks/1/token-secreto",
      "https://discord.com:8443/api/webhooks/1/token-secreto",
      "https://usuario@discord.com/api/webhooks/1/token-secreto",
      "https://discord.com/api/webhooks/no-numerico/token-secreto",
      "https://discord.com/api/webhooks/1",
      "https://discord.com/api/webhooks/1/token-secreto?wait=true",
      "https://discord.com/api/webhooks/1/token-secreto#x",
      "https://discord.com/api/webhooks/1/token-secreto/github",
      "",
    ]) {
      const error = errorOf(() => checkCredentials({ webhookUrl }, "discord"));
      expect(error, webhookUrl).toMatchObject({ code: "CREDENTIALS_INVALID" });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(
        "token-secreto",
      );
    }
  });

  it("checkConnectedCredentials usa la variante de la plataforma", () => {
    expect(checkConnectedCredentials("discord", { webhookUrl: WEBHOOK })).toEqual({
      webhookUrl: WEBHOOK,
    });
    expect(() => checkConnectedCredentials("discord", null)).toThrow(
      expect.objectContaining({ code: "ACCOUNT_CREDENTIALS_REQUIRED" }),
    );
    expect(() => checkConnectedCredentials("discord", { accessToken: "a" })).toThrow(
      expect.objectContaining({ code: "CREDENTIALS_INVALID" }),
    );
    expect(() => checkConnectedCredentials("x", { accessToken: "a" })).toThrow(
      expect.objectContaining({ code: "CREDENTIALS_INVALID" }),
    );
    expect(() => checkConnectedCredentials("fb_marketplace", { webhookUrl: WEBHOOK })).toThrow(
      expect.objectContaining({ code: "ACCOUNT_CREDENTIALS_NOT_ALLOWED" }),
    );
  });

  it("la unión se discrimina por la plataforma, que no va en lo guardado", () => {
    expect(
      platformCredentialsSchema.parse({
        platform: "discord",
        credentials: { webhookUrl: WEBHOOK },
      }),
    ).toEqual({ platform: "discord", credentials: { webhookUrl: WEBHOOK } });
    expect(
      platformCredentialsSchema.parse({ platform: "fb_marketplace", credentials: null }),
    ).toEqual({ platform: "fb_marketplace", credentials: null });
    expect(
      platformCredentialsSchema.safeParse({
        platform: "discord",
        credentials: { accessToken: "a" },
      }).success,
    ).toBe(false);
    expect(Object.keys(PLATFORM_CREDENTIALS_SCHEMAS).sort()).toEqual([...PLATFORMS].sort());
  });

  it("al escribir es estricta (una clave de más no calza) y al leer, laxa", () => {
    for (const [platform, credentials] of [
      ["instagram", { accessToken: "IGAA-a", expires: "never" }],
      ["instagram", { accessToken: "IGAA-a", refreshToken: "r" }],
      ["portal_inmobiliario", { accessToken: "APP_USR-a", refreshToken: "TG-b", extra: "x" }],
      ["discord", { webhookUrl: WEBHOOK, accessToken: "a" }],
    ] as const) {
      expect(() => checkCredentials(credentials, platform), platform).toThrow(
        expect.objectContaining({ code: "CREDENTIALS_INVALID" }),
      );
    }
    // Lo guardado con una clave de más se sigue leyendo: la variante laxa la descarta.
    expect(
      platformCredentialsSchema.parse({
        platform: "instagram",
        credentials: { accessToken: "IGAA-a", expires: "never" },
      }),
    ).toEqual({ platform: "instagram", credentials: { accessToken: "IGAA-a" } });
  });

  it("la marca de que el token no vence vive en meta, sin secretos, y no admite vencimiento", () => {
    const meta = {
      accountType: "BUSINESS",
      permissions: null,
      connectedAt: "2026-10-19T12:00:00.000Z",
      tokenRefreshedAt: null,
      tokenExpiryEstimated: false,
      tokenNeverExpires: true,
    };
    expect(instagramAccountMetaSchema.parse(meta)).toEqual(meta);
    expect(
      instagramAccountMetaSchema.safeParse({ ...meta, tokenNeverExpires: false }).success,
    ).toBe(false);
    expect(accountTokenNeverExpires({ meta })).toBe(true);
    expect(accountTokenNeverExpires({ meta: { tokenNeverExpires: "true" } })).toBe(false);
    expect(accountTokenNeverExpires({ meta: {} })).toBe(false);

    expect(() => checkTokenExpiry(meta, null)).not.toThrow();
    expect(() => checkTokenExpiry({}, new Date("2027-01-01T00:00:00Z"))).not.toThrow();
    expect(() => checkTokenExpiry(meta, new Date("2027-01-01T00:00:00Z"))).toThrow(
      expect.objectContaining({ code: "ACCOUNT_META_INVALID", retriable: false }),
    );
  });

  it("accessTokenOf entrega el token y falla cerrado con un webhook", () => {
    expect(accessTokenOf({ accessToken: "IGAA-a" })).toBe("IGAA-a");
    expect(hasAccessToken({ webhookUrl: WEBHOOK })).toBe(false);
    const error = errorOf(() => accessTokenOf({ webhookUrl: WEBHOOK }));
    expect(error).toMatchObject({ code: "ACCESS_TOKEN_UNAVAILABLE", retriable: false });
    expect(JSON.stringify(error)).not.toContain("token-falso");
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

  it("acepta la cuenta conectada, con o sin el último error; la de F5 (sin mode) es de perfil", () => {
    expect(marketplaceAccountMetaSchema.parse(meta)).toEqual({ ...meta, mode: "profile" });
    const withError = {
      ...meta,
      mode: "profile",
      lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: "2026-10-10T09:00:00.000Z" },
    };
    expect(marketplaceAccountMetaSchema.parse(withError)).toEqual(withError);
  });

  it("la cuenta a mano (F7) solo lleva el modo y cuándo se activó", () => {
    const manual = { mode: "manual", connectedAt: "2026-10-17T12:00:00.000Z" };
    expect(marketplaceAccountMetaSchema.parse(manual)).toEqual(manual);
    expect(marketplaceAccountMetaSchema.safeParse({ mode: "otro" }).success).toBe(false);
    expect(isManualMarketplaceAccount({ platform: "fb_marketplace", meta: manual })).toBe(true);
    expect(isManualMarketplaceAccount({ platform: "fb_marketplace", meta })).toBe(false);
    expect(isManualMarketplaceAccount({ platform: "instagram", meta: manual })).toBe(false);
  });

  it.each([{ userId: "abc" }, { userId: "" }, { connectedAt: "ayer" }])("rechaza %o", (change) => {
    expect(marketplaceAccountMetaSchema.safeParse({ ...meta, ...change }).success).toBe(false);
  });
});

describe("Discord (F9-T14)", () => {
  it("discordWebhookParts: el id y el token de la URL; otra cosa es CREDENTIALS_INVALID sin la URL", () => {
    expect(discordWebhookParts("https://discord.com/api/webhooks/987/tok-en_1")).toEqual({
      id: "987",
      token: "tok-en_1",
    });
    expect(discordWebhookParts("https://discordapp.com/api/webhooks/1/x").id).toBe("1");
    for (const value of ["https://example.com/api/webhooks/1/secreto", "secreto"]) {
      let error: unknown = null;
      try {
        discordWebhookParts(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
      expect((error as Error).message).not.toContain("secreto");
    }
  });

  it("la meta de una cuenta de Discord: sin secretos, con el servidor y el canal (o null)", () => {
    const meta = {
      webhookName: "AgentSales",
      guildId: "111",
      channelId: null,
      connectedAt: "2026-10-20T12:00:00.000Z",
    };
    expect(discordAccountMetaSchema.parse(meta)).toEqual(meta);
    expect(discordAccountMetaSchema.parse({ ...meta, mode: "manual" }).mode).toBe("manual");
    expect(discordAccountMetaSchema.safeParse({ ...meta, guildId: "abc" }).success).toBe(false);
  });
});
