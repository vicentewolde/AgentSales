import { randomUUID } from "node:crypto";
import { AppError, type NewListing } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { testDeps } from "../../test/app-deps.js";
import { createApp } from "../app.js";
import {
  brokerListResponseSchema,
  errorBodySchema,
  listingDetailResponseSchema,
  listingListResponseSchema,
  listingStatusResponseSchema,
} from "../contracts/index.js";

/** Aviso sintético (datos inventados). */
const newListing = (brokerId: string, externalRef: string, extra: Partial<NewListing> = {}) => ({
  brokerId,
  externalRef,
  category: "real_estate" as const,
  source: "xlsx" as const,
  operation: "sale" as const,
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: "Calle Inventada 123",
  unitNumber: null,
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF" as const,
  highlights: null,
  internalNotes: null,
  attributes: { dormitorios: 3 },
  sourceHash: "hash",
  ...extra,
});

async function setup() {
  const listings = createInMemoryListingRepository({ nextId: randomUUID });
  const media = createInMemoryMediaRepository();
  const brokers = createInMemoryBrokerRepository();
  const app = createApp(testDeps({ listings, brokers, media }));
  const broker = await brokers.create({
    slug: "marca",
    name: "Persona Inventada",
    brandName: "Marca Inventada",
    primaryColor: "#112233",
    secondaryColor: "#112233",
    whatsapp: null,
    email: null,
    instagramHandle: null,
    website: null,
    tone: null,
    fixedHashtags: [],
  });
  /** Un aviso, con fotos si se piden (la primera, de portada). */
  const addListing = async (ref: string, extra: Partial<NewListing> = {}, photos = 0) => {
    const listing = await listings.create(newListing(broker.id, ref, extra));
    for (let index = 0; index < photos; index++) {
      const photo = await media.create({
        listingId: listing.id,
        brokerId: broker.id,
        kind: "image",
        storagePath: `brokers/${broker.id}/listings/${listing.id}/original/${ref}-${index}.jpg`,
        mime: "image/jpeg",
        bytes: 1000 + index,
        checksum: `${ref}-${index}`,
        sortOrder: index,
        isCover: false,
      });
      if (index === 0)
        await media.arrange(listing.id, [{ id: photo.id, sortOrder: 0, isCover: true }]);
    }
    return listing;
  };
  const patch = (id: string, body: unknown) =>
    app.request(`/listings/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, listings, broker, addListing, patch };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json());

describe("GET /listings", () => {
  it("lista con la URL firmada de la portada (null sin fotos), con el contrato compartido", async () => {
    const { app, addListing, broker } = await setup();
    const withPhoto = await addListing("P001", {}, 2);
    await addListing("P002");

    const response = await app.request("/listings");

    expect(response.status).toBe(200);
    const body = listingListResponseSchema.parse(await response.json());
    const byRef = new Map(body.listings.map((listing) => [listing.externalRef, listing]));
    expect(byRef.get("P001")?.coverUrl).toBe(
      `https://r2.test/brokers/${broker.id}/listings/${withPhoto.id}/original/P001-0.jpg?firma`,
    );
    expect(byRef.get("P002")?.coverUrl).toBeNull();
    expect(byRef.get("P001")?.createdAt).toBeInstanceOf(Date);
  });

  it("filtra por estado, operación y comuna", async () => {
    const { app, addListing, listings } = await setup();
    const ready = await addListing("P001", { comuna: "Providencia" }, 1);
    await listings.promoteToReady(ready.id);
    await addListing("P002", { comuna: "Providencia", operation: "rent" });
    await addListing("P003", { comuna: "Ñuñoa" });

    const refs = async (query: string) =>
      listingListResponseSchema
        .parse(await (await app.request(`/listings?${query}`)).json())
        .listings.map((listing) => listing.externalRef)
        .sort();

    expect(await refs("comuna=Providencia")).toEqual(["P001", "P002"]);
    expect(await refs("status=ready")).toEqual(["P001"]);
    expect(await refs("operation=rent")).toEqual(["P002"]);
  });

  it("un filtro inválido es 400 REQUEST_INVALID, con el campo en el mensaje", async () => {
    const { app } = await setup();
    const response = await app.request("/listings?status=vendido");
    expect(response.status).toBe(400);
    const { error } = await errorOf(response);
    expect(error.code).toBe("REQUEST_INVALID");
    expect(error.message).toContain("status");
  });
});

describe("GET /listings/:id", () => {
  it("detalle con sus medios en orden y URLs firmadas", async () => {
    const { app, addListing } = await setup();
    const listing = await addListing("P001", { internalNotes: "nota del operador" }, 2);

    const response = await app.request(`/listings/${listing.id}`);

    expect(response.status).toBe(200);
    const body = listingDetailResponseSchema.parse(await response.json());
    expect(body.listing).toMatchObject({ id: listing.id, externalRef: "P001", status: "draft" });
    expect(
      body.media.map((item) => [item.sortOrder, item.isCover, item.url.endsWith("?firma")]),
    ).toEqual([
      [0, true, true],
      [1, false, true],
    ]);
  });

  it("un id que no existe es 404 LISTING_NOT_FOUND", async () => {
    const { app } = await setup();
    const response = await app.request(`/listings/${randomUUID()}`);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).error.code).toBe("LISTING_NOT_FOUND");
  });

  it("un id que no es uuid es 400 REQUEST_INVALID, sin llegar al repositorio", async () => {
    const { app } = await setup();
    const response = await app.request("/listings/no-es-un-uuid");
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error.code).toBe("REQUEST_INVALID");
  });
});

describe("PATCH /listings/:id/status", () => {
  it("un cambio permitido devuelve el aviso actualizado", async () => {
    const { addListing, patch } = await setup();
    const listing = await addListing("P001", {}, 1);

    const response = await patch(listing.id, { status: "ready" });

    expect(response.status).toBe(200);
    const body = listingStatusResponseSchema.parse(await response.json());
    expect(body.listing.status).toBe("ready");
  });

  it("ready sin fotos es 409 INVALID_TRANSITION", async () => {
    const { addListing, patch } = await setup();
    const listing = await addListing("P001");

    const response = await patch(listing.id, { status: "ready" });

    expect(response.status).toBe(409);
    const { error } = await errorOf(response);
    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.message).toContain("foto");
  });

  it("una transición que no está en la tabla es 409 INVALID_TRANSITION", async () => {
    const { addListing, patch } = await setup();
    const listing = await addListing("P001");

    const response = await patch(listing.id, { status: "paused" });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).error.code).toBe("INVALID_TRANSITION");
  });

  it("un JSON mal formado es 400 INVALID_JSON, en español", async () => {
    const { app, addListing } = await setup();
    const listing = await addListing("P001");

    const response = await app.request(`/listings/${listing.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toEqual({
      code: "INVALID_JSON",
      message: "El cuerpo de la petición no es JSON válido",
    });
  });

  it.each([{ status: "active" }, { status: "draft" }, {}, { status: 5 }])(
    "un cuerpo inválido (%j) es 400 REQUEST_INVALID",
    async (body) => {
      const { addListing, patch } = await setup();
      const listing = await addListing("P001");
      const response = await patch(listing.id, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).error.code).toBe("REQUEST_INVALID");
    },
  );

  it("un aviso que no existe es 404", async () => {
    const { patch } = await setup();
    expect((await patch(randomUUID(), { status: "archived" })).status).toBe(404);
  });
});

describe("GET /brokers", () => {
  it("lista los corredores con el contrato compartido", async () => {
    const { app, broker } = await setup();
    const response = await app.request("/brokers");
    expect(response.status).toBe(200);
    expect(brokerListResponseSchema.parse(await response.json())).toEqual({ brokers: [broker] });
  });
});

describe("datos corruptos en la base", () => {
  it("una fila inválida (LISTING_ROW_INVALID) es 500 con su código, no culpa del cliente", async () => {
    const { app, listings } = await setup();
    listings.list = async () => {
      throw new AppError("LISTING_ROW_INVALID", "El aviso x tiene datos inválidos");
    };

    const response = await app.request("/listings");

    expect(response.status).toBe(500);
    expect((await errorOf(response)).error.code).toBe("LISTING_ROW_INVALID");
  });
});
