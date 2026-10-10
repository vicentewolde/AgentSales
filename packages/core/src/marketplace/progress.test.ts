import { describe, expect, it } from "vitest";
import { checkPublicationProgress } from "../publication.js";
import {
  marketplaceManualState,
  marketplacePriceText,
  marketplaceProgressSchema,
} from "./progress.js";

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

describe("marketplaceManualState (spec F5 §4.10)", () => {
  const publication = (extra: Partial<Parameters<typeof marketplaceManualState>[0]> = {}) => ({
    platform: "fb_marketplace",
    status: "awaiting_manual_confirm",
    attempts: 2,
    progress: progress as unknown,
    ...extra,
  });

  it("el formulario del intento actual, con la ventana abierta y el precio con la UF usada", () => {
    expect(marketplaceManualState(publication())).toEqual({
      formReadyAt: new Date("2026-10-09T15:00:00.000Z"),
      simulated: false,
      windowOpen: true,
      windowClosedAt: null,
      photos: 8,
      priceClp: 238_559_452,
      ufValue: "41130.94",
      ufDate: "2026-10-09",
    });
  });

  it("la ventana no está abierta si se cerró, si es simulación o si ya no espera", () => {
    const closed = { ...progress, windowClosedAt: "2026-10-09T15:30:00.000Z" };
    expect(marketplaceManualState(publication({ progress: closed }))).toMatchObject({
      windowOpen: false,
      windowClosedAt: new Date("2026-10-09T15:30:00.000Z"),
    });
    expect(
      marketplaceManualState(publication({ progress: { ...progress, simulated: true } })),
    ).toMatchObject({ windowOpen: false, simulated: true });
    expect(marketplaceManualState(publication({ status: "published" }))).toMatchObject({
      windowOpen: false,
      priceClp: 238_559_452,
    });
  });

  it("sin UF, los campos de la UF van en null", () => {
    const { ufValue: _value, ufDate: _date, ...inPesos } = progress;
    expect(marketplaceManualState(publication({ progress: inPesos }))).toMatchObject({
      ufValue: null,
      ufDate: null,
    });
  });

  it("null en otra plataforma, sin progreso, con uno que no calza o de un intento anterior", () => {
    expect(marketplaceManualState(publication({ platform: "portal_inmobiliario" }))).toBeNull();
    expect(marketplaceManualState(publication({ progress: null }))).toBeNull();
    expect(marketplaceManualState(publication({ progress: { attempt: 2 } }))).toBeNull();
    expect(marketplaceManualState(publication({ attempts: 3, status: "publishing" }))).toBeNull();
  });
});

describe("marketplacePriceText (spec F5 §4.6)", () => {
  it("el precio en pesos y, si se convirtió, el valor de la UF usado y su día", () => {
    expect(
      marketplacePriceText({ priceClp: 238_559_452, ufValue: "41130.94", ufDate: "2026-10-09" }),
    ).toBe("$238.559.452 (UF del 2026-10-09: $41.130,94)");
    expect(marketplacePriceText({ priceClp: 650_000, ufValue: null, ufDate: null })).toBe(
      "$650.000",
    );
  });
});
