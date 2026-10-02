import { describe, expect, it } from "vitest";
import { describeAttributes } from "./attributes.js";

describe("describeAttributes", () => {
  it("primero los definidos en su orden y con etiqueta, luego el resto y al final _extra", () => {
    const entries = describeAttributes(
      {
        piscina: true,
        sin_definicion: "x",
        dormitorios: 3,
        _extra: { vista: "al cerro" },
        amenities: ["Quincho", "Gimnasio"],
      },
      [
        { key: "dormitorios", label: "Dormitorios" },
        { key: "amenities", label: "Amenities" },
        { key: "piscina", label: "Piscina" },
        { key: "no_esta", label: "No está" },
      ],
    );

    expect(entries).toEqual([
      { key: "dormitorios", label: "Dormitorios", value: "3", extra: false },
      { key: "amenities", label: "Amenities", value: "Quincho, Gimnasio", extra: false },
      { key: "piscina", label: "Piscina", value: "Sí", extra: false },
      { key: "sin_definicion", label: "sin_definicion", value: "x", extra: false },
      { key: "vista", label: "vista", value: "al cerro", extra: true },
    ]);
  });

  it.each([
    [false, "No"],
    [null, "—"],
    ["", "—"],
    [[], "—"],
    [120000, "120.000"],
    [2018, "2018"],
    [72.5, "72,5"],
    [1234.567, "1234,57"],
    [12345.678, "12.345,68"],
    [{ a: 1 }, '{"a":1}'],
  ])("%j → %s", (value, expected) => {
    expect(describeAttributes({ campo: value }, [])[0]?.value).toBe(expected);
  });

  it("un _extra nulo no aparece", () => {
    expect(describeAttributes({ _extra: null }, [])).toEqual([]);
  });

  it("un _extra que no es un objeto se muestra tal cual", () => {
    expect(describeAttributes({ _extra: "raro" }, [])).toEqual([
      { key: "_extra", label: "_extra", value: "raro", extra: false },
    ]);
  });
});
