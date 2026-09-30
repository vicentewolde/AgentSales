import { describe, expect, it } from "vitest";
import {
  foldText,
  isBlank,
  normalizeBoolean,
  normalizeDate,
  normalizeEnum,
  normalizeList,
  normalizeNumber,
  normalizeText,
  normalizeUrl,
} from "./normalizers.js";

describe("normalizeNumber", () => {
  it.each([
    [5800, 5800],
    ["5800", 5800],
    ["5.800", 5800],
    ["1.500", 1500],
    ["1.234.567", 1234567],
    ["1.234.567,8", 1234567.8],
    ["5 800", 5800],
    ["$650.000", 650000],
    ["72,5", 72.5],
    ["72.5", 72.5],
    ["1.2345", 1.2345],
    [" 12 ", 12],
    ["-3", -3],
  ])("%j → %d", (input, expected) => {
    expect(normalizeNumber(input)).toEqual({ ok: true, value: expected });
  });

  it.each(["abc", "5.80.0", "12,5,3", "5 UF", "1.234.56"])("%j → FIELD_NUMBER_INVALID", (input) => {
    expect(normalizeNumber(input)).toMatchObject({ ok: false, code: "FIELD_NUMBER_INVALID" });
  });

  it("rechaza números no finitos y fechas", () => {
    expect(normalizeNumber(Number.NaN)).toMatchObject({ ok: false });
    expect(normalizeNumber(new Date())).toMatchObject({ ok: false });
  });
});

describe("normalizeBoolean", () => {
  it.each([
    ["Sí", true],
    ["si", true],
    ["SI", true],
    [" No ", false],
    ["no", false],
    [true, true],
    [false, false],
  ])("%j → %s", (input, expected) => {
    expect(normalizeBoolean(input)).toEqual({ ok: true, value: expected });
  });

  it("rechaza otros valores", () => {
    expect(normalizeBoolean("quizás")).toMatchObject({ ok: false, code: "FIELD_BOOLEAN_INVALID" });
  });
});

describe("normalizeEnum", () => {
  const options = ["Venta", "Arriendo", "A consultar"];

  it("devuelve la opción tal como está escrita, sin importar mayúsculas, tildes ni espacios", () => {
    expect(normalizeEnum(" venta ", options)).toEqual({ ok: true, value: "Venta" });
    expect(normalizeEnum("a  CONSULTAR", options)).toEqual({ ok: true, value: "A consultar" });
    expect(normalizeEnum("Sí", ["Sí", "No"])).toEqual({ ok: true, value: "Sí" });
    expect(normalizeEnum("si", ["Sí", "No"])).toEqual({ ok: true, value: "Sí" });
  });

  it("rechaza una opción que no existe, listando las válidas", () => {
    expect(normalizeEnum("Permuta", options)).toEqual({
      ok: false,
      code: "FIELD_ENUM_INVALID",
      message: "«Permuta» no es una opción válida (Venta, Arriendo, A consultar)",
    });
  });
});

describe("normalizeList", () => {
  it("separa por comas, recorta y descarta vacíos", () => {
    expect(normalizeList("Piscina, gimnasio ,, quincho", null)).toEqual({
      ok: true,
      value: ["Piscina", "gimnasio", "quincho"],
    });
  });

  it("con opciones, valida cada elemento, lo canoniza y quita repetidos", () => {
    const options = ["Instagram", "Portal Inmobiliario", "Marketplace"];
    expect(normalizeList("instagram, portal inmobiliario, Instagram", options)).toEqual({
      ok: true,
      value: ["Instagram", "Portal Inmobiliario"],
    });
    expect(normalizeList("Instagarm, Marketplace", options)).toMatchObject({
      ok: false,
      code: "FIELD_LIST_INVALID",
      message: expect.stringContaining("«Instagarm»"),
    });
  });
});

describe("normalizeDate", () => {
  it.each([
    ["15-11-2026", "2026-11-15"],
    ["5/1/2027", "2027-01-05"],
    ["2026-11-15", "2026-11-15"],
    [new Date(Date.UTC(2026, 10, 15)), "2026-11-15"],
  ])("%j → %s", (input, expected) => {
    expect(normalizeDate(input)).toEqual({ ok: true, value: expected });
  });

  it.each(["31-02-2026", "Inmediata", "2026-13-01"])("%j → FIELD_DATE_INVALID", (input) => {
    expect(normalizeDate(input)).toMatchObject({ ok: false, code: "FIELD_DATE_INVALID" });
  });
});

describe("normalizeUrl", () => {
  it("acepta http y https con host", () => {
    expect(normalizeUrl(" https://youtu.be/abc?t=1 ")).toEqual({
      ok: true,
      value: "https://youtu.be/abc?t=1",
    });
    expect(normalizeUrl("http://example.cl")).toMatchObject({ ok: true });
  });

  it.each(["youtu.be/abc", "ftp://example.cl", "https://", "https://sin punto"])(
    "%j → FIELD_URL_INVALID",
    (input) => {
      expect(normalizeUrl(input)).toMatchObject({ ok: false, code: "FIELD_URL_INVALID" });
    },
  );
});

describe("normalizeText, isBlank y foldText", () => {
  it("convierte a texto números y fechas de Excel", () => {
    expect(normalizeText(1204)).toEqual({ ok: true, value: "1204" });
    expect(normalizeText(new Date(Date.UTC(2026, 10, 5)))).toEqual({
      ok: true,
      value: "05-11-2026",
    });
  });

  it("considera vacías las celdas sin valor o con solo espacios", () => {
    expect([null, undefined, "", "   "].every(isBlank)).toBe(true);
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
  });

  it("pliega mayúsculas, tildes y espacios", () => {
    expect(foldText("  Ñuñoa   Centro ")).toBe("nunoa centro");
  });
});
