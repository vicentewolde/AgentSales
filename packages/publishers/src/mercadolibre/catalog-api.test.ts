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

/** Una categoría como la devuelve Mercado Libre (ejemplo MLA de la nota §4.6, adaptado a MLC). */
const categoryBody = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

const attribute = (overrides: Record<string, unknown> = {}) => ({
  id: "BEDROOMS",
  name: "Dormitorios",
  tags: { required: true },
  value_type: "number",
  ...overrides,
});

const expectUnexpected = async (promise: Promise<unknown>, call: string) => {
  await expect(promise).rejects.toMatchObject({
    code: "ML_UNEXPECTED_RESPONSE",
    retriable: false,
    details: { call },
  });
};

describe("category", () => {
  it("hijas y los settings que usa el mapeo", async () => {
    server.use(http.get(`${API}/categories/MLC1459`, () => HttpResponse.json(categoryBody())));

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

  it("una hoja sin settings: sin hijas y sin límites inventados (null, no [])", async () => {
    server.use(
      http.get(`${API}/categories/MLC157520`, () =>
        HttpResponse.json({ id: "MLC157520", name: "Propiedades Usadas", children_categories: [] }),
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
        currencies: null,
        minimumPrice: null,
        maximumPrice: null,
      },
    });
  });

  it("settings raros quedan sin dato; de las monedas, solo los textos", async () => {
    server.use(
      http.get(`${API}/categories/MLC157520`, () =>
        HttpResponse.json(
          categoryBody({
            id: "MLC157520",
            children_categories: [],
            settings: {
              listing_allowed: "sí",
              max_title_length: -1,
              max_pictures_per_item: "30",
              currencies: ["CLP", 5, "CLF"],
            },
          }),
        ),
      ),
    );

    await expect(catalog.category(ACCESS, "MLC157520")).resolves.toMatchObject({
      settings: {
        listingAllowed: null,
        maxTitleLength: null,
        maxPicturesPerItem: null,
        currencies: ["CLP", "CLF"],
      },
    });
  });

  it("monedas que no son una lista: null (sin dato), distinto de [] (ninguna)", async () => {
    for (const [value, expected] of [
      ["CLP", null],
      [[], []],
    ] as const) {
      server.use(
        http.get(`${API}/categories/MLC1459`, () =>
          HttpResponse.json(categoryBody({ settings: { currencies: value } })),
        ),
      );
      const category = await catalog.category(ACCESS, "MLC1459");
      expect(category.settings.currencies).toEqual(expected);
    }
  });

  it("hijas que faltan o no se entienden: inesperado (no parece una hoja por error)", async () => {
    for (const children of [undefined, "MLC1472", [{ id: "MLC1472" }], [{ name: "Casas" }]]) {
      server.use(
        http.get(`${API}/categories/MLC1459`, () =>
          HttpResponse.json(categoryBody({ children_categories: children })),
        ),
      );
      await expectUnexpected(catalog.category(ACCESS, "MLC1459"), "category");
    }
  });

  it("la respuesta de otra categoría es ML_UNEXPECTED_RESPONSE (no se guardan datos ajenos)", async () => {
    server.use(
      http.get(`${API}/categories/MLC1459`, () => HttpResponse.json(categoryBody({ id: "MLC1" }))),
    );

    await expectUnexpected(catalog.category(ACCESS, "MLC1459"), "category");
  });
});

describe("attributes", () => {
  it("obligatorios, condicionales, tags, valores Sí/No y unidades", async () => {
    server.use(
      http.get(`${API}/categories/MLC157520/attributes`, () =>
        HttpResponse.json([
          attribute({ hierarchy: "ITEM", relevance: 1, value_max_length: 18 }),
          attribute({
            id: "COVERED_AREA",
            name: "Superficie útil",
            value_type: "number_unit",
            allowed_units: [{ id: "m²", name: "m²" }],
            default_unit: "m²",
          }),
          attribute({
            id: "FURNISHED",
            name: "Amoblado",
            tags: { conditional_required: true },
            value_type: "boolean",
            values: [
              { id: "242085", name: "Sí" },
              { id: "242084", name: "No" },
            ],
          }),
          attribute({
            id: "PROPERTY_TYPE",
            name: "Inmueble",
            tags: { required: true, fixed: true, read_only: true, hidden: false },
            value_type: "list",
          }),
          attribute({ id: "FLOORS", name: "Piso", tags: {} }),
          attribute({ id: "ORIENTATION", name: "Orientación", tags: undefined }),
        ]),
      ),
    );

    const attributes = await catalog.attributes(ACCESS, "MLC157520");

    expect(
      attributes.map(({ id, required, conditionalRequired, tags }) => ({
        id,
        required,
        conditionalRequired,
        tags,
      })),
    ).toEqual([
      { id: "BEDROOMS", required: true, conditionalRequired: false, tags: ["required"] },
      { id: "COVERED_AREA", required: true, conditionalRequired: false, tags: ["required"] },
      {
        id: "FURNISHED",
        required: false,
        conditionalRequired: true,
        tags: ["conditional_required"],
      },
      {
        id: "PROPERTY_TYPE",
        required: true,
        conditionalRequired: false,
        tags: ["required", "fixed", "read_only"],
      },
      { id: "FLOORS", required: false, conditionalRequired: false, tags: [] },
      { id: "ORIENTATION", required: false, conditionalRequired: false, tags: [] },
    ]);
    expect(attributes[0]).toEqual({
      id: "BEDROOMS",
      name: "Dormitorios",
      valueType: "number",
      required: true,
      conditionalRequired: false,
      tags: ["required"],
      values: [],
      allowedUnits: [],
      defaultUnit: null,
      valueMaxLength: 18,
    });
    expect(attributes[1]).toMatchObject({
      allowedUnits: [{ id: "m²", name: "m²" }],
      defaultUnit: "m²",
    });
    expect(attributes[2]?.values).toEqual([
      { id: "242085", name: "Sí" },
      { id: "242084", name: "No" },
    ]);
    await expectBearerOnly();
  });

  it.each([
    ["tags como lista", [attribute({ tags: ["required"] })]],
    ["tags como texto", [attribute({ tags: "required" })]],
    ["required como texto", [attribute({ tags: { required: "true" } })]],
    ["una entrada sin id", [attribute(), { name: "sin id", tags: { required: true } }]],
    ["una entrada que no es objeto", [attribute(), "BEDROOMS"]],
    ["valores raros", [attribute({ values: [{ id: "1" }] })]],
    ["una lista vacía", []],
    ["algo que no es lista", { data: [] }],
  ])("%s: inesperado (un obligatorio no se pierde en silencio)", async (_name, body) => {
    server.use(http.get(`${API}/categories/MLC157520/attributes`, () => HttpResponse.json(body)));

    await expectUnexpected(catalog.attributes(ACCESS, "MLC157520"), "attributes");
  });
});

describe("ubicaciones", () => {
  it("Chile con sus estados, un estado con sus ciudades, una ciudad con sus barrios", async () => {
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
          neighborhoods: [{ id: "TUxDQkFSUjE", name: "Centro" }],
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
      children: [{ id: "TUxDQkFSUjE", name: "Centro" }],
    });
    expect((await recorded()).map((request) => request.url.pathname)).toEqual([
      "/classified_locations/countries/CL",
      `/classified_locations/states/${STATE_ID}`,
      `/classified_locations/cities/${CITY_ID}`,
    ]);
    await expectBearerOnly();
  });

  it("una ciudad sin barrios (null o ausentes) queda sin hijos", async () => {
    for (const neighborhoods of [undefined, null, []]) {
      server.use(
        http.get(`${API}/classified_locations/cities/${CITY_ID}`, () =>
          HttpResponse.json({ id: CITY_ID, name: "La Estrella", neighborhoods }),
        ),
      );
      await expect(catalog.city(ACCESS, CITY_ID)).resolves.toMatchObject({ children: [] });
    }
  });

  it("un país sin estados o un estado sin ciudades: inesperado (no una región vacía)", async () => {
    server.use(
      http.get(`${API}/classified_locations/countries/CL`, () =>
        HttpResponse.json({ id: "CL", name: "Chile" }),
      ),
      http.get(`${API}/classified_locations/states/${STATE_ID}`, () =>
        HttpResponse.json({ id: STATE_ID, name: "O'Higgins", cities: [{ id: CITY_ID }] }),
      ),
    );

    await expectUnexpected(catalog.country(ACCESS, "CL"), "country");
    await expectUnexpected(catalog.state(ACCESS, STATE_ID), "state");

    server.use(
      http.get(`${API}/classified_locations/states/${STATE_ID}`, () =>
        HttpResponse.json({ id: STATE_ID, name: "O'Higgins" }),
      ),
    );
    await expectUnexpected(catalog.state(ACCESS, STATE_ID), "state");
  });

  it("la respuesta de otra ubicación es ML_UNEXPECTED_RESPONSE", async () => {
    server.use(
      http.get(`${API}/classified_locations/states/${STATE_ID}`, () =>
        HttpResponse.json({ id: "OTRO", name: "Otro", cities: [] }),
      ),
    );

    await expectUnexpected(catalog.state(ACCESS, STATE_ID), "state");
  });
});

describe("ids y errores", () => {
  it("un id con otra forma no se llama (ML_ID_INVALID, sin el valor)", async () => {
    const calls: Array<[(api: MercadoLibreCatalogApi) => Promise<unknown>, string]> = [
      [(api) => api.category(ACCESS, "../users/me"), "category"],
      [(api) => api.category(ACCESS, "MLA1459"), "category"],
      [(api) => api.category(ACCESS, "mlc1459"), "category"],
      [(api) => api.category(ACCESS, "MLC1459\n"), "category"],
      [(api) => api.attributes(ACCESS, "MLC1459/x"), "category"],
      [(api) => api.country(ACCESS, "cl"), "location"],
      [(api) => api.country(ACCESS, STATE_ID), "location"],
      [(api) => api.state(ACCESS, "a/../b"), "location"],
      [(api) => api.state(ACCESS, ""), "location"],
      [(api) => api.city(ACCESS, `${CITY_ID}\n`), "location"],
      [(api) => api.city(ACCESS, "x".repeat(65)), "location"],
    ];
    for (const [run, kind] of calls) {
      const error = await run(catalog).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "ML_ID_INVALID", details: { kind } });
      expect(errorText(error)).not.toMatch(/users\/me|a\/\.\.\/b|MLA1459/);
    }
    expect(await recorded()).toHaveLength(0);
  });

  const methods: Array<[string, string, (api: MercadoLibreCatalogApi) => Promise<unknown>]> = [
    ["category", "/categories/MLC1459", (api) => api.category(ACCESS, "MLC1459")],
    ["attributes", "/categories/MLC1459/attributes", (api) => api.attributes(ACCESS, "MLC1459")],
    ["country", "/classified_locations/countries/CL", (api) => api.country(ACCESS, "CL")],
    ["state", `/classified_locations/states/${STATE_ID}`, (api) => api.state(ACCESS, STATE_ID)],
    ["city", `/classified_locations/cities/${CITY_ID}`, (api) => api.city(ACCESS, CITY_ID)],
  ];

  it.each([
    [401, "ML_AUTH_INVALID", false],
    [403, "ML_PERMISSION_DENIED", false],
    [404, "ML_REQUEST_REJECTED", false],
    [429, "ML_RATE_LIMITED", true],
    [500, "ML_UNAVAILABLE", true],
  ] as const)("un %i en cualquier lectura es %s", async (status, code, retriable) => {
    for (const [, path, run] of methods) {
      server.use(http.get(`${API}${path}`, () => HttpResponse.json({}, { status })));
      const error = await run(catalog).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code, retriable });
      expect(errorText(error)).not.toContain(ACCESS);
    }
  });
});
