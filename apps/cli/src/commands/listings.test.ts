import { describe, expect, it } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";
import { runListings } from "./listings.js";

async function withListings() {
  const h = harness();
  const broker = await h.brokers.create(brokerData("marca"));
  const sale = await h.listings.create(newListing(broker.id, "P-001"));
  await h.listings.promoteToReady(sale.id);
  await h.listings.create(
    newListing(broker.id, "P-002", {
      operation: "rent",
      comuna: "Providencia",
      priceAmount: 650000,
      priceCurrency: "CLP",
    }),
  );
  return h;
}

describe("runListings", () => {
  it("tabla con corredor, precio en formato chileno, estado y portada", async () => {
    const h = await withListings();

    expect(await runListings({ ...h.io, client: h.client })).toBe(0);

    const [header, ...rows] = h.out[0]?.split("\n") ?? [];
    expect(header).toMatch(
      /^Propiedad\s+Corredor\s+Tipo\s+Operación\s+Comuna\s+Precio\s+Estado\s+Portada$/,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.startsWith("P-002"))).toMatch(
      /P-002\s+marca\s+Departamento\s+Arriendo\s+Providencia\s+\$650\.000\/mes\s+Borrador\s+no$/,
    );
    expect(rows.find((row) => row.startsWith("P-001"))).toMatch(
      /Venta\s+Ñuñoa\s+UF 5\.800\s+Lista/,
    );
    expect(h.text()).toContain("2 propiedad(es)");
  });

  it("--status filtra en la API", async () => {
    const h = await withListings();

    await runListings({ ...h.io, client: h.client }, { status: "ready" });

    expect(h.requests).toContain("GET /listings");
    expect(h.out[0]).toContain("P-001");
    expect(h.out[0]).not.toContain("P-002");
  });

  it("--json entrega los avisos completos", async () => {
    const h = await withListings();

    await runListings({ ...h.io, client: h.client }, { json: true });

    const parsed = JSON.parse(h.out[0] ?? "");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ externalRef: expect.any(String), coverUrl: null });
    expect(h.out).toHaveLength(1);
  });

  it("sin propiedades lo dice", async () => {
    const h = harness();

    await runListings({ ...h.io, client: h.client }, { status: "paused" });

    expect(h.text()).toBe("No hay propiedades en estado paused.");
  });

  it("un estado desconocido lo rechaza la API", async () => {
    const h = harness();

    // commander ya valida las opciones; esto cubre a quien llame sin pasar por él.
    const code = await runListings(
      { ...h.io, client: h.client },
      {
        status: "vendido" as never,
      },
    );

    expect(code).toBe(1);
    expect(h.errors()).toContain("✗ REQUEST_INVALID");
  });
});
