import { randomUUID } from "node:crypto";
import type { FieldDefinition } from "@agentsales/core";
import { createInMemoryFieldDefinitionRepository } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";
import { runListing } from "./listing.js";

/** Definición global sintética: solo importan la clave, la etiqueta y el orden. */
const definition = (key: string, label: string, sortOrder: number): FieldDefinition => ({
  id: randomUUID(),
  brokerId: null,
  category: "real_estate",
  key,
  label,
  type: "text",
  required: false,
  options: null,
  sourceColumn: key,
  isCore: false,
  sortOrder,
  active: true,
});

async function setup() {
  const h = harness({
    deps: {
      fieldDefinitions: createInMemoryFieldDefinitionRepository([
        definition("dormitorios", "Dormitorios", 1),
        definition("amenities", "Amenities", 2),
      ]),
    },
  });
  const marca = await h.brokers.create(brokerData("marca"));
  const otra = await h.brokers.create(brokerData("otra-marca"));
  const listing = await h.listings.create(
    newListing(marca.id, "P-001", {
      unitNumber: "45",
      highlights: "Luminoso",
      internalNotes: "Llaves en conserjería",
      attributes: {
        dormitorios: 3,
        amenities: ["Piscina", "Quincho"],
        acepta_mascotas: true,
        _extra: { vista: "al cerro" },
      },
    }),
  );
  const photo = await h.media.create({
    listingId: listing.id,
    brokerId: marca.id,
    kind: "image",
    storagePath: `brokers/${marca.id}/listings/${listing.id}/original/a.jpg`,
    mime: "image/jpeg",
    bytes: 1_258_291,
    checksum: "a",
    sortOrder: 0,
    isCover: false,
  });
  await h.media.arrange(listing.id, [{ id: photo.id, sortOrder: 0, isCover: true }]);
  await h.listings.create(newListing(otra.id, "P-002"));
  return { h, listing, marca, otra };
}

describe("runListing", () => {
  it("busca por id_propiedad y muestra el detalle, sus atributos y medios", async () => {
    const { h, listing } = await setup();

    expect(await runListing({ ...h.io, client: h.client }, "P-001")).toBe(0);

    expect(h.text()).toBe(
      [
        "P-001 · Departamento en venta · Ñuñoa",
        "  Estado: Borrador (draft) · Corredor: marca",
        "  Precio: UF 5.800",
        "  Dirección: Calle Inventada 123, 45, Ñuñoa, Metropolitana (no se publica la dirección exacta)",
        "  Destacados: Luminoso",
        "  Notas internas (no se publican): Llaves en conserjería",
        `  id: ${listing.id}`,
        "",
        "Atributos",
        "  Dormitorios: 3",
        "  Amenities: Piscina, Quincho",
        "  acepta_mascotas: Sí",
        "  vista (columna extra): al cerro",
        "",
        "Medios (1)",
        "  1. foto   image/jpeg  1,2 MB  portada",
      ].join("\n"),
    );
    expect(h.requests).toContain(`GET /listings/${listing.id}`);
  });

  it("un uuid va directo al detalle, aunque traiga espacios", async () => {
    const { h, listing } = await setup();

    expect(await runListing({ ...h.io, client: h.client }, ` ${listing.id} `)).toBe(0);
    expect(h.requests).toEqual(["GET /brokers", `GET /listings/${listing.id}`]);
  });

  it("si el id_propiedad está en dos corredores pide --broker, y con él lo encuentra", async () => {
    const { h, otra } = await setup();
    const repeated = await h.listings.create(newListing(otra.id, "P-001", { comuna: "Maipú" }));

    expect(await runListing({ ...h.io, client: h.client }, "P-001")).toBe(1);
    expect(h.errors()).toBe(
      "✗ LISTING_AMBIGUOUS: P-001 existe en 2 corredores (otra-marca, marca)\n  → Indica cuál con --broker <slug>",
    );

    // `--broker` se normaliza como slug.
    expect(await runListing({ ...h.io, client: h.client }, "P-001", { broker: "Otra Marca" })).toBe(
      0,
    );
    expect(h.text()).toContain(`id: ${repeated.id}`);
  });

  it.each([
    ["P-404", {}, "✗ LISTING_NOT_FOUND: No existe la propiedad P-404"],
    [
      "P-002",
      { broker: "marca" },
      "✗ LISTING_NOT_FOUND: No existe la propiedad P-002 en ese corredor",
    ],
    ["P-001", { broker: "nadie" }, "✗ BROKER_NOT_FOUND: No existe el corredor nadie"],
    [randomUUID(), {}, "✗ LISTING_NOT_FOUND"],
  ])("%s %j da un error claro", async (ref, options, message) => {
    const { h } = await setup();

    expect(await runListing({ ...h.io, client: h.client }, ref, options)).toBe(1);
    expect(h.errors()).toContain(message);
  });

  it("--json entrega el aviso y sus medios con las URLs", async () => {
    const { h, listing } = await setup();

    await runListing({ ...h.io, client: h.client }, "P-001", { json: true });

    const parsed = JSON.parse(h.out[0] ?? "");
    expect(parsed.listing.id).toBe(listing.id);
    expect(parsed.media[0]).toMatchObject({
      isCover: true,
      url: expect.stringContaining("?firma"),
    });
  });

  it("sin medios y con la dirección exacta publicable", async () => {
    const { h, otra } = await setup();
    await h.listings.create(
      newListing(otra.id, "P-003", { showExactAddress: true, operation: null, comuna: null }),
    );

    await runListing({ ...h.io, client: h.client }, "P-003");

    expect(h.text()).toContain("P-003 · Departamento\n");
    expect(h.text()).toContain("  Dirección: Calle Inventada 123, Metropolitana\n");
    expect(h.text()).toContain("Medios (0)\n  Sin fotos ni videos");
  });
});
