import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { createMercadoLibreCatalogApi, type MercadoLibreCatalogApi } from "./catalog-api.js";

const ACCESS = "APP_USR-1234567890123456-100612-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443";
const API = "https://api.mercadolibre.com";
const STATE_ID = "TUxDUE9IUzFjODg";
const CITY_ID = "TUxDQ0xBWmE0Y2Zm";

const { server, recorded } = usePlatformServer();
const catalog = createMercadoLibreCatalogApi();

const expectBearerOnly = async () => {
  for (const request of await recorded()) {
    expect(request.method).toBe("GET");
    expect(request.authorization).toBe(`Bearer ${ACCESS}`);
    expect(request.url.search).toBe("");
  }
};

describe("createMercadoLibreCatalogApi", () => {
  it("category: hijas y los settings que usa el mapeo (ejemplo de la doc, adaptado a MLC)", async () => {
    server.use(
      http.get(`${API}/categories/MLC1459`, () =>
        HttpResponse.json({
          id: "MLC1459",
          name: "Inmuebles",
          path_from_root: [{ id: "MLC1459", name: "Inmuebles" }],
          children_categories: [
            { id: "MLC1472", name: "Departamentos", total_items_in_this_category: 1234 },
            { id: "MLC1466", name: "Casas", total_items_in_this_category: 999 },
          ],
          settings: {
            listing_allowed: false,
            max_title_length: 200,
            max_pictures_per_item: 30,
            max_description_length: 50000,
            currencies: ["CLP", "CLF"],
            minimum_price: 1,
            maximum_price: 9999999999,
            rounded_address: false,
          },
        }),
      ),
    );

    await expect(catalog.category(ACCESS, "MLC1459")).resolves.toEqual({
      id: "MLC1459",
      name: "Inmuebles",
      childrenCategories: [
        { id: "MLC1472", name: "Departamentos" },
        { id: "MLC1466", name: "Casas" },
      ],
      settings: {
        listingAllowed: false,
        maxTitleLength: 200,
        maxPicturesPerItem: 30,
        maxDescriptionLength: 50000,
        currencies: ["CLP", "CLF"],
        minimumPrice: 1,
        maximumPrice: 9999999999,
      },
    });
    await expectBearerOnly();
  });

  it("category hoja sin settings o con valores raros: sin hijas y sin límites inventados", async () => {
    server.use(
      http.get(`${API}/categories/MLC157520`, () =>
        HttpResponse.json({
          id: "MLC157520",
          name: "Propiedades Usadas",
          children_categories: [{ id: 1 }, { name: "sin id" }],
          settings: {
            listing_allowed: "sí",
            max_title_length: -1,
            max_pictures_per_item: "30",
            currencies: "CLP",
          },
        }),
      ),
    );

    await expect(catalog.category(ACCESS, "MLC157520")).resolves.toEqual({
      id: "MLC157520",
      name: "Propiedades Usadas",
      childrenCategories: [],
      settings: {
        listingAllowed: null,
        maxTitleLength: null,
        maxPicturesPerItem: null,
        maxDescriptionLength: null,
        currencies: [],
        minimumPrice: null,
        maximumPrice: null,
      },
    });
  });

  it("attributes: obligatorios, condicionales, valores Sí/No y unidades", async () => {
    server.use(
      http.get(`${API}/categories/MLC157520/attributes`, () =>
        HttpResponse.json([
          {
            id: "BEDROOMS",
            name: "Dormitorios",
            tags: { required: true },
            hierarchy: "ITEM",
            relevance: 1,
            value_type: "number",
            value_max_length: 18,
          },
          {
            id: "COVERED_AREA",
            name: "Superficie útil",
            tags: { required: true },
            value_type: "number_unit",
            allowed_units: [{ id: "m²", name: "m²" }],
            default_unit: "m²",
          },
          {
            id: "FURNISHED",
            name: "Amoblado",
            tags: { conditional_required: true },
            value_type: "boolean",
            values: [
              { id: "242085", name: "Sí" },
              { id: "242084", name: "No" },
            ],
          },
          { id: "FLOORS", name: "Piso", tags: {}, value_type: "number" },
          { name: "sin id" },
        ]),
      ),
    );

    const attributes = await catalog.attributes(ACCESS, "MLC157520");

    expect(attributes).toEqual([
      {
        id: "BEDROOMS",
        name: "Dormitorios",
        valueType: "number",
        required: true,
        conditionalRequired: false,
        values: [],
        allowedUnits: [],
        defaultUnit: null,
        valueMaxLength: 18,
      },
      {
        id: "COVERED_AREA",
        name: "Superficie útil",
        valueType: "number_unit",
        required: true,
        conditionalRequired: false,
        values: [],
        allowedUnits: [{ id: "m²", name: "m²" }],
        defaultUnit: "m²",
        valueMaxLength: null,
      },
      {
        id: "FURNISHED",
        name: "Amoblado",
        valueType: "boolean",
        required: false,
        conditionalRequired: true,
        values: [
          { id: "242085", name: "Sí" },
          { id: "242084", name: "No" },
        ],
        allowedUnits: [],
        defaultUnit: null,
        valueMaxLength: null,
      },
      {
        id: "FLOORS",
        name: "Piso",
        valueType: "number",
        required: false,
        conditionalRequired: false,
        values: [],
        allowedUnits: [],
        defaultUnit: null,
        valueMaxLength: null,
      },
    ]);
    await expectBearerOnly();
  });

  it("attributes que no son una lista es ML_UNEXPECTED_RESPONSE", async () => {
    server.use(
      http.get(`${API}/categories/MLC157520/attributes`, () => HttpResponse.json({ data: [] })),
    );

    await expect(catalog.attributes(ACCESS, "MLC157520")).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { call: "attributes" },
    });
  });

  it("ubicaciones: Chile con sus estados, un estado con sus ciudades, una ciudad con sus barrios", async () => {
    server.use(
      http.get(`${API}/classified_locations/countries/CL`, () =>
        HttpResponse.json({
          id: "CL",
          name: "Chile",
          locale: "es_CL",
          currency_id: "CLP",
          states: [{ id: STATE_ID, name: "Libertador B. O'Higgins" }],
        }),
      ),
      http.get(`${API}/classified_locations/states/${STATE_ID}`, () =>
        HttpResponse.json({
          id: STATE_ID,
          name: "Libertador B. O'Higgins",
          country: { id: "CL", name: "Chile" },
          cities: [{ id: CITY_ID, name: "La Estrella" }],
        }),
      ),
      http.get(`${API}/classified_locations/cities/${CITY_ID}`, () =>
        HttpResponse.json({
          id: CITY_ID,
          name: "La Estrella",
          state: { id: STATE_ID, name: "Libertador B. O'Higgins" },
          neighborhoods: [],
        }),
      ),
    );

    await expect(catalog.country(ACCESS, "CL")).resolves.toEqual({
      id: "CL",
      name: "Chile",
      children: [{ id: STATE_ID, name: "Libertador B. O'Higgins" }],
    });
    await expect(catalog.state(ACCESS, STATE_ID)).resolves.toEqual({
      id: STATE_ID,
      name: "Libertador B. O'Higgins",
      children: [{ id: CITY_ID, name: "La Estrella" }],
    });
    await expect(catalog.city(ACCESS, CITY_ID)).resolves.toEqual({
      id: CITY_ID,
      name: "La Estrella",
      children: [],
    });
    expect((await recorded()).map((request) => request.url.pathname)).toEqual([
      "/classified_locations/countries/CL",
      `/classified_locations/states/${STATE_ID}`,
      `/classified_locations/cities/${CITY_ID}`,
    ]);
    await expectBearerOnly();
  });

  it("una ubicación sin la lista de abajo queda sin hijos (no rompe)", async () => {
    server.use(
      http.get(`${API}/classified_locations/cities/${CITY_ID}`, () =>
        HttpResponse.json({ id: CITY_ID, name: "La Estrella" }),
      ),
    );

    await expect(catalog.city(ACCESS, CITY_ID)).resolves.toMatchObject({ children: [] });
  });

  it("la respuesta de otro id es ML_UNEXPECTED_RESPONSE (no se guardan datos ajenos)", async () => {
    server.use(
      http.get(`${API}/categories/MLC1459`, () => HttpResponse.json({ id: "MLC1", name: "Otra" })),
      http.get(`${API}/classified_locations/states/${STATE_ID}`, () =>
        HttpResponse.json({ id: "OTRO", name: "Otro", cities: [] }),
      ),
    );

    await expect(catalog.category(ACCESS, "MLC1459")).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { call: "category" },
    });
    await expect(catalog.state(ACCESS, STATE_ID)).rejects.toMatchObject({
      code: "ML_UNEXPECTED_RESPONSE",
      details: { call: "state" },
    });
  });

  it("un id con otra forma no se llama (ML_ID_INVALID, sin el valor)", async () => {
    const calls: Array<[(api: MercadoLibreCatalogApi) => Promise<unknown>, string]> = [
      [(api) => api.category(ACCESS, "../users/me"), "category"],
      [(api) => api.attributes(ACCESS, "MLC1459/x"), "category"],
      [(api) => api.country(ACCESS, "C L"), "location"],
      [(api) => api.state(ACCESS, "a/../b"), "location"],
      [(api) => api.city(ACCESS, "x".repeat(65)), "location"],
    ];
    for (const [run, kind] of calls) {
      const error = await run(catalog).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "ML_ID_INVALID", details: { kind } });
      expect(errorText(error)).not.toMatch(/users\/me|C L|a\/\.\.\/b/);
    }
    expect(await recorded()).toHaveLength(0);
  });

  it.each([
    [401, "ML_AUTH_INVALID", false],
    [403, "ML_PERMISSION_DENIED", false],
    [404, "ML_REQUEST_REJECTED", false],
    [429, "ML_RATE_LIMITED", true],
    [500, "ML_UNAVAILABLE", true],
  ] as const)("un %i al leer el catálogo es %s", async (status, code, retriable) => {
    server.use(http.get(`${API}/categories/MLC1459`, () => HttpResponse.json({}, { status })));

    const error = await catalog.category(ACCESS, "MLC1459").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, retriable });
    expect(errorText(error)).not.toContain(ACCESS);
  });
});
