import { describe, expect, it } from "vitest";
import { isMarketplaceItemUrl, marketplaceItemUrl, parseMarketplaceItemUrl } from "./url.js";

describe("parseMarketplaceItemUrl", () => {
  it.each([
    "https://www.facebook.com/marketplace/item/1234567890/",
    "https://www.facebook.com/marketplace/item/1234567890",
    "https://facebook.com/marketplace/item/1234567890/",
    "https://m.facebook.com/marketplace/item/1234567890/",
    "https://web.facebook.com/marketplace/item/1234567890/",
    "  https://WWW.Facebook.com/marketplace/item/1234567890/?ref=share&tracking=abc#fotos  ",
  ])("reconoce %s y devuelve la forma limpia", (value) => {
    expect(parseMarketplaceItemUrl(value)).toEqual({
      itemId: "1234567890",
      url: "https://www.facebook.com/marketplace/item/1234567890/",
    });
    expect(isMarketplaceItemUrl(value)).toBe(true);
  });

  it.each([
    "http://www.facebook.com/marketplace/item/1234567890/",
    "https://www.facebook.com/marketplace/item/abc/",
    "https://www.facebook.com/marketplace/item/",
    "https://www.facebook.com/marketplace/create/rental",
    "https://www.facebook.com/marketplace/item/123/extra",
    "https://www.facebook.com.evil.test/marketplace/item/123/",
    "https://evil.test/www.facebook.com/marketplace/item/123/",
    "https://usuario:clave@www.facebook.com/marketplace/item/123/",
    "https://www.facebook.com:8443/marketplace/item/123/",
    "https://l.facebook.com/marketplace/item/123/",
    "",
    "no es un enlace",
  ])("rechaza %s sin repetirlo en el error", (value) => {
    let caught: unknown;
    try {
      parseMarketplaceItemUrl(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "MARKETPLACE_URL_INVALID", retriable: false });
    if (value.length > 0) expect((caught as Error).message).not.toContain(value);
    expect(isMarketplaceItemUrl(value)).toBe(false);
  });

  it("marketplaceItemUrl arma el enlace que se guarda", () => {
    expect(marketplaceItemUrl("42")).toBe("https://www.facebook.com/marketplace/item/42/");
  });
});
