import { describe, expect, it } from "vitest";
import { portalProgressSchema, portalSellerContactSchema } from "./progress.js";

describe("progreso de Portal (spec F4 §4.8)", () => {
  const contact = {
    contact: "Vinny",
    email: "vinny@example.com",
    countryCode2: "56",
    phone2: "912345678",
  };

  it("empieza con las fotos subidas y suma cada paso", () => {
    expect(portalProgressSchema.parse({ pictureIds: [] })).toEqual({ pictureIds: [] });
    const full = {
      pictureIds: ["f1", "f2"],
      sellerContact: contact,
      createRequestedAt: "2026-10-06T12:00:00.000Z",
      itemId: "MLC1234567",
      descriptionDone: true,
      addressHidden: false,
    };
    expect(portalProgressSchema.parse(full)).toEqual(full);
  });

  it("el WhatsApp va solo con dígitos, como lo exige Mercado Libre", () => {
    expect(portalSellerContactSchema.safeParse(contact).success).toBe(true);
    for (const phone2 of ["+56912345678", "9 1234 5678", "9-1234-5678", ""]) {
      expect(portalSellerContactSchema.safeParse({ ...contact, phone2 }).success).toBe(false);
    }
    expect(portalSellerContactSchema.safeParse({ ...contact, countryCode2: "+56" }).success).toBe(
      false,
    );
  });

  it("rechaza fotos vacías y fechas que no son ISO", () => {
    expect(portalProgressSchema.safeParse({ pictureIds: [""] }).success).toBe(false);
    expect(
      portalProgressSchema.safeParse({ pictureIds: [], createRequestedAt: "recién" }).success,
    ).toBe(false);
  });
});
