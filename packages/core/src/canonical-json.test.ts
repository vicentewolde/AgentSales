import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("da el mismo texto sin importar el orden de las claves, en todos los niveles", () => {
    const a = { b: 1, a: { d: [3, 1], c: null } };
    const b = { a: { c: null, d: [3, 1] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it("mantiene el orden de los arreglos, que es parte del dato", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("conserva claves como __proto__ (objetos sin prototipo)", () => {
    const extra = Object.fromEntries([["__proto__", "valor"]]);
    expect(canonicalJson({ _extra: extra })).toBe('{"_extra":{"__proto__":"valor"}}');
  });

  it("serializa las fechas con toJSON, como JSON.stringify (no como {})", () => {
    const date = new Date(Date.UTC(2026, 10, 15));
    expect(canonicalJson({ fecha: date })).toBe('{"fecha":"2026-11-15T00:00:00.000Z"}');
  });
});
