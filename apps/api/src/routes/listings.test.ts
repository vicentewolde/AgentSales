import { randomUUID } from "node:crypto";
import {
  AppError,
  type FieldDefinition,
  type NewListing,
  type PublicationRepository,
} from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import {
  brokerListResponseSchema,
  errorBodySchema,
  listingDetailResponseSchema,
  listingListResponseSchema,
  listingStatusResponseSchema,
} from "../contracts/index.js";
import { adminApp, testDeps } from "../testing/index.js";

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
  const deps = testDeps({ listings, brokers, media });
  const app = adminApp(deps);
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
  const post = (id: string, body: unknown) =>
    app.request(`/listings/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    app,
    listings, // El doble completo (la app solo lee): el test crea y mueve publicaciones.
    publications: deps.publications as PublicationRepository,
    broker,
    addListing,
    post,
  };
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
    expect(await refs("externalRef=P003")).toEqual(["P003"]);
    expect(await refs(`externalRef=${encodeURIComponent(" P003 ")}`)).toEqual(["P003"]);
    expect(await refs("externalRef=p003")).toEqual([]);
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

  it("trae las etiquetas de sus atributos: las del corredor ganan, sin inactivas ni fijas", async () => {
    const definition = (key: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
      id: randomUUID(),
      brokerId: null,
      category: "real_estate",
      key,
      label: key,
      type: "text",
      required: false,
      options: null,
      sourceColumn: key,
      isCore: false,
      minValue: null,
      maxValue: null,
      sortOrder: 0,
      active: true,
      ...extra,
    });
    const listings = createInMemoryListingRepository({ nextId: randomUUID });
    const brokers = createInMemoryBrokerRepository();
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
    const app = adminApp(
      testDeps({
        listings,
        brokers,
        fieldDefinitions: createInMemoryFieldDefinitionRepository([
          definition("dormitorios", { label: "Dormitorios", type: "number", sortOrder: 2 }),
          definition("banos", { label: "Baños", type: "number", sortOrder: 1 }),
          // El corredor renombra "banos"; su definición gana.
          definition("banos", {
            brokerId: broker.id,
            label: "Baños completos",
            type: "number",
            sortOrder: 1,
          }),
          definition("bodega", { label: "Bodega", active: false, sortOrder: 3 }),
          definition("comuna", { label: "Comuna", isCore: true }),
          definition("piscina", { label: "Piscina", type: "boolean", sortOrder: 4 }),
        ]),
      }),
    );
    const listing = await listings.create(
      newListing(broker.id, "P001", {
        attributes: { dormitorios: 3, banos: 2, bodega: true, _extra: { vista: "mar" } },
      }),
    );

    const body = listingDetailResponseSchema.parse(
      await (await app.request(`/listings/${listing.id}`)).json(),
    );

    expect(body.fields).toEqual([
      { key: "banos", label: "Baños completos", type: "number" },
      { key: "dormitorios", label: "Dormitorios", type: "number" },
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

describe("POST /listings/:id/status (F6-T10)", () => {
  it("una acción permitida devuelve la propiedad, lo que cambió y las tareas a mano", async () => {
    const { addListing, post } = await setup();
    const listing = await addListing("P001", {}, 1);

    const response = await post(listing.id, { action: "ready" });

    expect(response.status).toBe(200);
    const body = listingStatusResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ listing: { status: "ready" }, changed: [], manualTasks: [] });
  });

  it("ready sin fotos es 409 INVALID_TRANSITION", async () => {
    const { addListing, post } = await setup();
    const listing = await addListing("P001");

    const response = await post(listing.id, { action: "ready" });

    expect(response.status).toBe(409);
    const { error } = await errorOf(response);
    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.message).toContain("foto");
  });

  it("una acción que no sale de ese estado es 409 INVALID_TRANSITION", async () => {
    const { addListing, post } = await setup();
    const listing = await addListing("P001");

    const response = await post(listing.id, { action: "resume" });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).error.code).toBe("INVALID_TRANSITION");
  });

  it("pausar con algo programado pide confirmación (409) y con confirmed lo desprograma", async () => {
    const { addListing, listings, publications, post } = await setup();
    const listing = await addListing("P001", {}, 1);
    await listings.promoteToReady(listing.id);
    const publication = await publications.create(
      {
        listingId: listing.id,
        platformAccountId: randomUUID(),
        platform: "instagram",
        format: "post",
        contentId: randomUUID(),
        mediaIds: [],
        listingSourceHash: "hash",
      },
      { actor: "operator" },
    );
    await publications.transition(
      publication.id,
      {
        from: "approved",
        to: "scheduled",
        changes: { dryRun: true, scheduledAt: new Date(Date.now() + 3_600_000) },
      },
      { actor: "operator" },
    );

    const refused = await post(listing.id, { action: "pause" });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).error.code).toBe("LISTING_ACTION_NOT_CONFIRMED");
    expect((await listings.get(listing.id))?.status).toBe("ready");

    const response = await post(listing.id, { action: "pause", confirmed: true });
    expect(response.status).toBe(200);
    const body = listingStatusResponseSchema.parse(await response.json());
    expect(body.listing.status).toBe("paused");
    expect(body.changed).toMatchObject([{ id: publication.id, status: "approved" }]);
  });

  it("cerrar sin motivo es 400 CLOSE_REASON_REQUIRED; con motivo y confirmación lo guarda", async () => {
    const { addListing, listings, post } = await setup();
    const listing = await addListing("P001", {}, 1);
    await listings.promoteToReady(listing.id);

    const missing = await post(listing.id, { action: "close", confirmed: true });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).error.code).toBe("CLOSE_REASON_REQUIRED");

    const response = await post(listing.id, { action: "close", reason: "sold", confirmed: true });
    expect(response.status).toBe(200);
    expect(listingStatusResponseSchema.parse(await response.json()).listing).toMatchObject({
      status: "closed",
      closeReason: "sold",
    });
  });

  it("un JSON mal formado es 400 INVALID_JSON, en español", async () => {
    const { app, addListing } = await setup();
    const listing = await addListing("P001");

    const response = await app.request(`/listings/${listing.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toEqual({
      code: "INVALID_JSON",
      message: "El cuerpo de la petición no es JSON válido",
    });
  });

  it.each([
    { action: "vender" },
    { status: "paused" },
    {},
    { action: "close", reason: "regalada" },
  ])("un cuerpo inválido (%j) es 400 REQUEST_INVALID", async (body) => {
    const { addListing, post } = await setup();
    const listing = await addListing("P001");
    const response = await post(listing.id, body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error.code).toBe("REQUEST_INVALID");
  });

  it("una propiedad que no existe es 404, y el PATCH viejo ya no existe", async () => {
    const { app, post } = await setup();
    expect((await post(randomUUID(), { action: "archive" })).status).toBe(404);
    const old = await app.request(`/listings/${randomUUID()}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(old.status).toBe(404);
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
