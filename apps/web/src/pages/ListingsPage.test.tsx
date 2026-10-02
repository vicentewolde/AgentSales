// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";

afterEach(cleanup);

/** Dos avisos: P-001 en venta, lista y con portada; P-002 en arriendo, borrador y sin foto. */
async function withListings(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const broker = await h.brokers.create(brokerData("marca"));
  const sale = await h.listings.create(newListing(broker.id, "P-001"));
  const photo = await h.media.create({
    listingId: sale.id,
    brokerId: broker.id,
    kind: "image",
    storagePath: `brokers/${broker.id}/listings/${sale.id}/original/a.jpg`,
    mime: "image/jpeg",
    bytes: 1000,
    checksum: "a",
    sortOrder: 0,
    isCover: false,
  });
  await h.media.arrange(sale.id, [{ id: photo.id, sortOrder: 0, isCover: true }]);
  await h.listings.promoteToReady(sale.id);
  await h.listings.create(
    newListing(broker.id, "P-002", {
      operation: "rent",
      comuna: "Providencia",
      priceAmount: 650000,
      priceCurrency: "CLP",
    }),
  );
  return { ...h, sale, broker };
}

const cards = () => within(screen.getByRole("list", { name: "Resultados" })).getAllByRole("link");
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

describe("panel: Propiedades", () => {
  it("grilla con portada, operación, tipo, comuna, precio chileno y estado", async () => {
    const { renderApp, sale, broker } = await withListings();
    renderApp("/propiedades");

    const p1 = await screen.findByRole("link", { name: "P-001: Departamento · Ñuñoa" });
    expect(p1.getAttribute("href")).toBe(`/propiedades/${sale.id}`);
    expect(within(p1).getByText("Venta")).toBeTruthy();
    expect(within(p1).getByText("UF 5.800")).toBeTruthy();
    expect(within(p1).getByText("Lista")).toBeTruthy();
    expect(within(p1).getByRole("img", { name: "Portada de P-001" }).getAttribute("src")).toBe(
      `https://r2.test/brokers/${broker.id}/listings/${sale.id}/original/a.jpg?firma`,
    );

    const p2 = screen.getByRole("link", { name: "P-002: Departamento · Providencia" });
    expect(within(p2).getByText("Arriendo")).toBeTruthy();
    expect(within(p2).getByText("$650.000/mes")).toBeTruthy();
    expect(within(p2).getByText("Borrador")).toBeTruthy();
    expect(within(p2).getByText("Sin foto")).toBeTruthy();
    expect(screen.getByText("2 propiedad(es)")).toBeTruthy();
  });

  it("toma los filtros de la URL y se los pide a la API", async () => {
    const { renderApp, requests } = await withListings();
    renderApp("/propiedades?status=ready&comuna=%C3%91u%C3%B1oa");

    await screen.findByRole("link", { name: /P-001/ });
    expect(cards()).toHaveLength(1);
    expect(select("Estado").value).toBe("ready");
    expect(select("Comuna").value).toBe("Ñuñoa");
    expect(requests).toContain(`GET /listings?status=ready&comuna=${encodeURIComponent("Ñuñoa")}`);
  });

  it("un filtro desconocido en la URL se ignora", async () => {
    const { renderApp, requests } = await withListings();
    renderApp("/propiedades?status=vendido");

    await screen.findByRole("link", { name: /P-002/ });
    expect(cards()).toHaveLength(2);
    expect(requests).not.toContain("GET /listings?status=vendido");
  });

  it("cambiar un filtro actualiza la lista, y Quitar filtros vuelve a todas", async () => {
    const { renderApp } = await withListings();
    renderApp("/propiedades");
    await screen.findByRole("link", { name: /P-002/ });

    // Las comunas del selector salen de las propiedades cargadas.
    expect(
      within(select("Comuna"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Todos", "Ñuñoa", "Providencia"]);

    fireEvent.change(select("Operación"), { target: { value: "rent" } });
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.getAttribute("aria-label")).toContain("P-002");

    fireEvent.click(screen.getByRole("button", { name: "Quitar filtros" }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(select("Operación").value).toBe("");
  });

  it("sin resultados lo dice, distinto si hay filtros", async () => {
    const { renderApp } = await withListings();
    renderApp("/propiedades?status=archived");
    expect(await screen.findByText("No hay propiedades con esos filtros.")).toBeTruthy();
    cleanup();

    harness().renderApp("/propiedades");
    expect(await screen.findByText(/Todavía no hay propiedades/)).toBeTruthy();
  });

  it("un error de la API se muestra con su sugerencia y se recupera con Reintentar", async () => {
    let failing = true;
    const { renderApp } = await withListings({
      intercept: (_method, path) =>
        failing && path.startsWith("/listings")
          ? Response.json(
              { error: { code: "DB_UNAVAILABLE", message: "La base no responde" } },
              { status: 503 },
            )
          : undefined,
    });
    renderApp("/propiedades");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("DB_UNAVAILABLE: La base no responde");
    expect(alert.textContent).toContain("Neon puede estar despertando");

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));

    await screen.findByRole("link", { name: /P-001/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("una tarjeta lleva al detalle", async () => {
    const { renderApp } = await withListings();
    renderApp("/propiedades");

    fireEvent.click(await screen.findByRole("link", { name: /P-001/ }));

    expect(await screen.findByRole("heading", { name: /Departamento en venta/ })).toBeTruthy();
  });
});
