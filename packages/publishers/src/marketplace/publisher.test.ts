import { type PublishInput, withDryRun } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createMarketplacePublisher, validateMarketplaceInput } from "./publisher.js";

const input: PublishInput = {
  publicationId: "pub-1",
  platform: "fb_marketplace",
  format: "post",
  title: "Departamento en arriendo 2 dormitorios en Ñuñoa",
  caption: "Texto inventado.",
  media: [1, 2].map((n) => ({
    mediaId: `m-${n}`,
    kind: "image" as const,
    mime: "image/jpeg",
    storagePath: `brokers/b/listings/l/processed/pi_4x3/${n}.jpg`,
    url: `memory://foto-${n}`,
    bytes: 1000,
    width: 1600,
    height: 1200,
    durationS: null,
  })),
  listing: {
    id: "l",
    externalRef: "P001",
    operation: "rent",
    propertyType: "Departamento",
    region: "RM",
    comuna: "Ñuñoa",
    address: null,
    unitNumber: null,
    showExactAddress: false,
    priceAmount: 650_000,
    priceCurrency: "CLP",
    attributes: {},
  },
  priceClp: 650_000,
  uf: null,
};

describe("publisher de Marketplace (esqueleto, F5-T05)", () => {
  it("declara el paso manual y un solo formato", () => {
    const publisher = createMarketplacePublisher();
    expect(publisher).toMatchObject({
      platform: "fb_marketplace",
      formats: ["post"],
      manualConfirm: true,
    });
    expect(publisher.validate(input)).toEqual({ ok: true });
  });

  it("valida título, fotos JPEG, el aviso y el precio en pesos", () => {
    expect(
      validateMarketplaceInput({
        ...input,
        title: "x".repeat(61),
        media: [{ ...(input.media[0] as PublishInput["media"][number]), mime: "image/png" }],
        priceClp: undefined,
      }).map((issue) => issue.code),
    ).toEqual(["TITLE_TOO_LONG", "PHOTO_NOT_JPEG", "PRICE_MISSING"]);
    expect(
      validateMarketplaceInput({ ...input, title: " ", media: [] }).map((issue) => issue.code),
    ).toEqual(["TITLE_MISSING", "PHOTOS_INVALID"]);
  });

  it("en live todavía no abre nada; en simulación deja el formulario listo", async () => {
    const publisher = createMarketplacePublisher();
    const ctx = {
      account: {} as never,
      progress: null,
      saveProgress: async () => undefined,
    };
    await expect(publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "PUBLISHER_NOT_CONFIGURED",
    });
    await expect(withDryRun(publisher).publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
      simulated: true,
    });
  });
});
