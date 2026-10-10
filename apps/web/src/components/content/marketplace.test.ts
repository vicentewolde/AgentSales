import type { MarketplaceManualView, PublicationView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { planBPrice } from "./marketplace.js";

const manual: MarketplaceManualView = {
  formReadyAt: new Date("2026-10-10T15:00:00Z"),
  simulated: false,
  windowOpen: false,
  windowClosedAt: null,
  photos: 3,
  priceClp: 238_559_452,
  ufValue: "41130.94",
  ufDate: "2026-10-10",
};
const publication = (
  status: PublicationView["status"],
  withManual = true,
): Pick<PublicationView, "status" | "manual" | "updatedAt"> => ({
  status,
  manual: withManual ? manual : null,
  updatedAt: new Date("2026-10-10T15:00:00Z"),
});
const uf = { priceAmount: 5800, priceCurrency: "UF" as const, operation: "sale" as const };
const clp = { priceAmount: 650_000, priceCurrency: "CLP" as const, operation: "rent" as const };

describe("planBPrice (spec F5 §4.12)", () => {
  it("en pesos con la UF si una publicación activa tiene el formulario", () => {
    expect(planBPrice([publication("awaiting_manual_confirm")], uf)).toBe(
      "$238.559.452 (UF del 2026-10-10: $41.130,94)",
    );
  });

  it("una descartada o retirada no cuenta (pudo usar un precio viejo)", () => {
    expect(planBPrice([publication("cancelled"), publication("unpublished")], uf)).toBe(
      "UF 5.800 (sin convertir: Marketplace lo pide en pesos)",
    );
  });

  it("sin intento: en UF dice que no está convertido; en pesos, tal cual", () => {
    expect(planBPrice([], uf)).toBe("UF 5.800 (sin convertir: Marketplace lo pide en pesos)");
    expect(planBPrice([publication("approved", false)], clp)).toBe("$650.000/mes");
    expect(planBPrice([], null)).toBe("—");
  });
});
