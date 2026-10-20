import { describe, expect, it } from "vitest";
import { X_LINK_POST_COST_USD, X_POST_COST_USD } from "../social/networks.js";
import { formatXUsd, xPostCostUsd } from "./cost.js";

describe("el costo de un post de X", () => {
  it("formatXUsd escribe los centavos con al menos dos decimales y los enteros sin ellos", () => {
    expect(formatXUsd(X_LINK_POST_COST_USD)).toBe("US$0,20");
    expect(formatXUsd(X_POST_COST_USD)).toBe("US$0,015");
    expect(formatXUsd(10)).toBe("US$10");
    expect(formatXUsd(12.5)).toBe("US$12,50");
  });

  it("un enlace en el texto sube el costo", () => {
    expect(xPostCostUsd("Hola")).toBe(X_POST_COST_USD);
    expect(xPostCostUsd("Más en agentpey.com")).toBe(X_LINK_POST_COST_USD);
  });
});
