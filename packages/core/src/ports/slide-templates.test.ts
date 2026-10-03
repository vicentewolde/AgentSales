import { describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical-json.js";
import { type CoverData, type SlideImageRef, slideKeyInput } from "./slide-templates.js";

const ref = (sha256: string): SlideImageRef => ({ mime: "image/jpeg", sha256 });

const cover = (photo: SlideImageRef, logo: SlideImageRef | null): CoverData<SlideImageRef> => ({
  operation: "sale",
  propertyType: "Departamento",
  comuna: "Ñuñoa",
  price: "UF 5.800",
  facts: [{ icon: "area", text: "72,5 m²" }],
  photo,
  brand: { brandName: "Inventada", primaryColor: "#1F4E79", secondaryColor: "#F2A900", logo },
});

describe("slideKeyInput", () => {
  it("con o sin bytes da la misma clave: las imágenes cuentan solo por su sha256", () => {
    const withBytes = cover(
      { ...ref("foto"), bytes: new Uint8Array([1, 2, 3]) } as SlideImageRef,
      { ...ref("logo"), bytes: new Uint8Array([4]) } as SlideImageRef,
    );
    const withoutBytes = cover(ref("foto"), ref("logo"));

    expect(canonicalJson(slideKeyInput(withBytes))).toBe(
      canonicalJson(slideKeyInput(withoutBytes)),
    );
    expect(canonicalJson(slideKeyInput(withBytes))).not.toContain('"0"');
  });

  it("otra foto, otro logo o un dato distinto cambian la clave", () => {
    const base = canonicalJson(slideKeyInput(cover(ref("foto"), ref("logo"))));

    expect(canonicalJson(slideKeyInput(cover(ref("otra"), ref("logo"))))).not.toBe(base);
    expect(canonicalJson(slideKeyInput(cover(ref("foto"), null)))).not.toBe(base);
    expect(
      canonicalJson(slideKeyInput({ ...cover(ref("foto"), ref("logo")), price: "UF 5.900" })),
    ).not.toBe(base);
  });
});
