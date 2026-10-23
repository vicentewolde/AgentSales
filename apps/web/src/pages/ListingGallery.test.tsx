// @vitest-environment jsdom
import { type ListingAttributes, listingSubject } from "@agentsales/core";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  brokerData,
  createInMemoryFieldDefinitionRepository,
  definition,
  harness,
  newListing,
} from "../../test/harness.js";

// F9.5-T26: la galería con que abre la ficha (su forma según cuántas fotos hay y la portada
// primero) y las cifras destacadas, solo las que la propiedad tiene.

afterEach(cleanup);

async function setup(photos: number, cover: number, attributes: ListingAttributes = {}) {
  const h = harness({
    deps: {
      fieldDefinitions: createInMemoryFieldDefinitionRepository([
        definition("dormitorios", "Dormitorios", 1),
        definition("banos", "Baños", 2),
        definition("sup_util_m2", "Superficie útil (m²)", 3),
      ]),
    },
  });
  const broker = await h.brokers.create(brokerData("marca"));
  const listing = await h.listings.create(newListing(broker.id, "P-001", { attributes }));
  const created = [];
  for (let index = 0; index < photos; index++) {
    created.push(
      await h.media.create({
        listingId: listing.id,
        brokerId: broker.id,
        kind: "image",
        storagePath: `brokers/${broker.id}/listings/${listing.id}/original/${index}.jpg`,
        mime: "image/jpeg",
        bytes: 1000 + index,
        checksum: String(index),
        sortOrder: index,
        isCover: false,
      }),
    );
  }
  if (created.length > 0) {
    await h.media.arrange(
      listingSubject(listing.id),
      created.map((item, index) => ({ id: item.id, sortOrder: index, isCover: index === cover })),
    );
  }
  h.renderApp(`/propiedades/${listing.id}`);
  await screen.findByRole("heading", { level: 1 });
  return h;
}

const gallery = () => screen.getByRole("list", { name: "Galería" });

describe("la galería de la ficha (F9.5-T26)", () => {
  it("con una foto, la muestra sola a todo el ancho", async () => {
    await setup(1, 0);
    const items = within(gallery()).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(gallery().className).toContain("grid-cols-1");
    expect(items[0]?.className).not.toContain("row-span");
    expect(within(gallery()).getByText("Portada")).toBeTruthy();
  });

  it("de dos a cuatro, una fila pareja sin mosaico", async () => {
    await setup(3, 0);
    expect(gallery().className).toContain("sm:grid-cols-3");
    for (const item of within(gallery()).getAllByRole("listitem")) {
      expect(item.className).not.toContain("row-span");
    }
  });

  it("desde cinco, el mosaico con la primera en dos filas", async () => {
    await setup(6, 0);
    const items = within(gallery()).getAllByRole("listitem");
    expect(items[0]?.className).toContain("sm:row-span-2");
    expect(items[1]?.className).not.toContain("row-span");
  });

  it("la portada va primero aunque no sea la primera del orden", async () => {
    await setup(3, 2);
    const first = within(gallery()).getAllByRole("listitem")[0];
    if (first === undefined) throw new Error("Sin fotos en la galería");
    expect(within(first).getByText("Portada")).toBeTruthy();
    expect(within(first).getByRole("img").getAttribute("src")).toMatch(
      /\/original\/2\.jpg\?firma$/,
    );
    expect(within(first).getByRole("img", { name: "Foto 1 de P-001" })).toBeTruthy();
  });
});

describe("las cifras destacadas de la ficha (F9.5-T26)", () => {
  it("muestra solo las que la propiedad tiene, en singular o plural", async () => {
    await setup(1, 0, { dormitorios: 3, banos: 1, sup_util_m2: 78 });
    const figures = screen.getByRole("list", { name: "Cifras destacadas" });
    expect(
      within(figures)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["3dormitorios", "1baño", "78 m²útiles"]);
  });

  it("sin esos datos no inventa nada", async () => {
    await setup(1, 0, {});
    expect(screen.queryByRole("list", { name: "Cifras destacadas" })).toBeNull();
  });
});
