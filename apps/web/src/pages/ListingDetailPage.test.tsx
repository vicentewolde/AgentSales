// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  brokerData,
  createInMemoryFieldDefinitionRepository,
  definition,
  harness,
  newListing,
} from "../../test/harness.js";

afterEach(cleanup);

async function setup({
  photos = 1,
  video = false,
  options = {},
}: {
  photos?: number;
  video?: boolean;
  options?: Parameters<typeof harness>[0];
} = {}) {
  const h = harness({
    ...options,
    deps: {
      fieldDefinitions: createInMemoryFieldDefinitionRepository([
        definition("dormitorios", "Dormitorios", 1),
        definition("gastos_comunes", "Gastos comunes", 2),
        definition("ano_construccion", "Año de construcción", 3),
      ]),
      ...options.deps,
    },
  });
  const broker = await h.brokers.create(brokerData("marca"));
  const listing = await h.listings.create(
    newListing(broker.id, "P-001", {
      unitNumber: "45",
      highlights: "Luminoso",
      internalNotes: "Llaves en conserjería",
      attributes: {
        gastos_comunes: 120000,
        ano_construccion: 2018,
        dormitorios: 3,
        piscina: true,
        _extra: { vista: "al cerro" },
      },
    }),
  );
  const items = [
    ...Array.from({ length: photos }, (_, index) => ({ kind: "image" as const, index })),
    ...(video ? [{ kind: "video" as const, index: photos }] : []),
  ];
  const created = [];
  for (const { kind, index } of items) {
    created.push(
      await h.media.create({
        listingId: listing.id,
        brokerId: broker.id,
        kind,
        storagePath: `brokers/${broker.id}/listings/${listing.id}/original/${index}.${kind === "image" ? "jpg" : "mp4"}`,
        mime: kind === "image" ? "image/jpeg" : "video/mp4",
        bytes: 1000 + index,
        checksum: String(index),
        sortOrder: index,
        isCover: false,
      }),
    );
  }
  if (created[0]) {
    await h.media.arrange(
      listing.id,
      created.map((item, index) => ({ id: item.id, sortOrder: index, isCover: index === 0 })),
    );
  }
  return { ...h, listing };
}

describe("panel: Detalle de una propiedad", () => {
  it("muestra título, precio, datos, atributos con su etiqueta y la galería", async () => {
    const { renderApp, listing } = await setup({ photos: 2, video: true });
    renderApp(`/propiedades/${listing.id}`);

    expect(
      await screen.findByRole("heading", { name: "Departamento en venta · Ñuñoa" }),
    ).toBeTruthy();
    expect(screen.getByText("UF 5.800")).toBeTruthy();
    expect(screen.getByText("Borrador")).toBeTruthy();

    const datos = screen.getByRole("region", { name: "Datos" });
    expect(within(datos).getByText(/Calle Inventada 123, 45, Ñuñoa, Metropolitana/)).toBeTruthy();
    expect(within(datos).getByText("No se publica la dirección exacta.")).toBeTruthy();
    expect(within(datos).getByText("Llaves en conserjería")).toBeTruthy();

    const atributos = screen.getByRole("region", { name: "Atributos" });
    const pairs = within(atributos)
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(pairs).toEqual([
      ["Dormitorios", "3"],
      ["Gastos comunes", "120.000"],
      // Un año no lleva punto de miles (RAE: cuatro cifras sin separador).
      ["Año de construcción", "2018"],
      ["piscina", "Sí"],
      ["vista(extra)", "al cerro"],
    ]);

    expect(screen.getByText("Fotos y videos (3)")).toBeTruthy();
    const first = screen.getByRole("img", { name: "Foto 1 de P-001" });
    expect(first.getAttribute("src")).toMatch(/\/original\/0\.jpg\?firma$/);
    expect(within(first.closest("li") as HTMLElement).getByText("Portada")).toBeTruthy();
    expect(screen.getByLabelText("Video 3 de P-001").tagName).toBe("VIDEO");
  });

  it("cambia el estado con los botones permitidos y actualiza la vista", async () => {
    const { renderApp, listing, requests } = await setup();
    renderApp(`/propiedades/${listing.id}`);

    fireEvent.click(await screen.findByRole("button", { name: "Marcar como lista" }));

    await screen.findByText("Lista");
    expect(requests).toContain(`PATCH /listings/${listing.id}/status`);
    expect(screen.getByRole("button", { name: "Pausar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archivar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Marcar como lista" })).toBeNull();
  });

  it("si la API rechaza el cambio (sin fotos), muestra el motivo", async () => {
    const { renderApp, listing } = await setup({ photos: 0 });
    renderApp(`/propiedades/${listing.id}`);

    expect(await screen.findByText(/Sin fotos ni videos/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Marcar como lista" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("INVALID_TRANSITION");
    expect(screen.getByText("Borrador")).toBeTruthy();
  });

  it("después de cambiar el estado, la lista ya no está en caché vieja", async () => {
    const { renderApp, requests } = await setup();
    renderApp("/propiedades");
    fireEvent.click(await screen.findByRole("link", { name: /P-001/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Marcar como lista" }));
    await screen.findByText("Lista");

    fireEvent.click(screen.getByRole("link", { name: "← Propiedades" }));

    const card = await screen.findByRole("link", { name: /P-001/ });
    await waitFor(() => expect(within(card).getByText("Lista")).toBeTruthy());
    expect(requests.filter((request) => request === "GET /listings")).toHaveLength(2);
  });

  it.each([
    ["paused", ["Reanudar", "Archivar"]],
    ["archived", ["Desarchivar"]],
    ["active", []],
    ["closed", []],
  ] as const)("desde %s ofrece %j", async (status, buttons) => {
    const { renderApp, listing, listings } = await setup();
    listings.setStatus(listing.id, status);
    renderApp(`/propiedades/${listing.id}`);

    await screen.findByRole("heading", { name: /Departamento en venta/ });
    // Los botones de cambio de estado: los de la sección Contenido son otra cosa (F2-T14).
    const contentSection = screen.getByRole("region", { name: "Contenido" });
    const actions = screen
      .queryAllByRole("button")
      .filter((button) => !contentSection.contains(button))
      .map((button) => button.textContent)
      .filter((text) => text !== "Reintentar");
    expect(actions).toEqual(buttons);
    expect(
      within(contentSection)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Preparar contenido", "Rehacer imágenes"]);
  });

  it("con datos vacíos no muestra secciones de más", async () => {
    const h = harness();
    const broker = await h.brokers.create(brokerData("marca"));
    const bare = await h.listings.create(
      newListing(broker.id, "P-009", {
        operation: null,
        propertyType: null,
        comuna: null,
        showExactAddress: true,
        attributes: {},
      }),
    );
    h.renderApp(`/propiedades/${bare.id}`);

    expect(await screen.findByRole("heading", { name: "Propiedad" })).toBeTruthy();
    const datos = screen.getByRole("region", { name: "Datos" });
    expect(within(datos).getByText("Calle Inventada 123, Metropolitana")).toBeTruthy();
    expect(within(datos).queryByText("No se publica la dirección exacta.")).toBeNull();
    expect(within(datos).queryByText("Destacados")).toBeNull();
    expect(within(datos).queryByText("Notas internas")).toBeNull();
    expect(screen.getByText("Sin atributos.")).toBeTruthy();
  });

  it.each([
    ["no existe", () => randomUUID()],
    ["no es un uuid", () => "no-es-un-id"],
  ])("un id que %s dice que la propiedad no existe", async (_label, id) => {
    harness().renderApp(`/propiedades/${id()}`);

    expect(await screen.findByText("Esta propiedad no existe.")).toBeTruthy();
  });

  it("con la API caída lo dice y se recupera con Reintentar", async () => {
    let down = true;
    const { renderApp, listing } = await setup({
      options: {
        intercept: () => {
          if (down) throw new TypeError("fetch failed");
          return undefined;
        },
      },
    });
    renderApp(`/propiedades/${listing.id}`);

    const alert = await screen.findByText("La API no responde");
    expect(alert.closest("[role=alert]")?.textContent).toContain("pnpm dev");

    down = false;
    fireEvent.click(screen.getAllByRole("button", { name: "Reintentar" })[0] as HTMLElement);

    expect(await screen.findByRole("heading", { name: /Departamento en venta/ })).toBeTruthy();
  });
});
