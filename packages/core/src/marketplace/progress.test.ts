import { describe, expect, it } from "vitest";
import { checkPublicationProgress } from "../publication.js";
import { marketplaceProgressSchema } from "./progress.js";

const progress = {
  attempt: 2,
  simulated: false,
  formReadyAt: "2026-10-09T15:00:00.000Z",
  photos: 8,
  priceClp: 238_559_452,
  ufValue: "41130.94",
  ufDate: "2026-10-09",
};

describe("marketplaceProgressSchema", () => {
  it("acepta el progreso de un formulario listo, con y sin la UF y la ventana cerrada", () => {
    expect(marketplaceProgressSchema.parse(progress)).toEqual(progress);
    const { ufValue: _value, ufDate: _date, ...inPesos } = progress;
    expect(
      marketplaceProgressSchema.parse({ ...inPesos, windowClosedAt: "2026-10-09T15:30:00.000Z" }),
    ).toMatchObject({ windowClosedAt: "2026-10-09T15:30:00.000Z" });
  });

  it.each([
    { attempt: 0 },
    { priceClp: 1.5 },
    { priceClp: -1 },
    { photos: -1 },
    { ufValue: "41.130,94" },
    { ufDate: "09-10-2026" },
    { formReadyAt: "ayer" },
  ])("rechaza %o", (change) => {
    expect(marketplaceProgressSchema.safeParse({ ...progress, ...change }).success).toBe(false);
  });

  it("es el progreso de Marketplace en las publicaciones", () => {
    expect(checkPublicationProgress("fb_marketplace", progress)).toEqual(progress);
    expect(() => checkPublicationProgress("fb_marketplace", { pictureIds: [] })).toThrow(
      expect.objectContaining({ code: "PUBLICATION_PROGRESS_INVALID" }),
    );
  });
});
