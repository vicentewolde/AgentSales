import { describe, expect, it } from "vitest";
import { formatPrice } from "./price.js";

describe("formatPrice", () => {
  it.each([
    [5800, "UF", "UF 5.800"],
    [3250.5, "UF", "UF 3.250,50"],
    [12.345, "UF", "UF 12,35"],
    [999.999, "UF", "UF 1.000"],
    [0.5, "UF", "UF 0,50"],
    [650000, "CLP", "$650.000"],
    [1234567.6, "CLP", "$1.234.568"],
    [999, "CLP", "$999"],
    [123456789012, "CLP", "$123.456.789.012"],
  ] as const)("%d %s → %s", (amount, currency, expected) => {
    expect(formatPrice(amount, currency)).toBe(expected);
  });

  it("un negativo conserva el signo (no debería llegar: el precio es mayor que 0)", () => {
    expect(formatPrice(-1500, "CLP")).toBe("-$1.500");
    expect(formatPrice(-2.5, "UF")).toBe("UF -2,50");
  });
});
