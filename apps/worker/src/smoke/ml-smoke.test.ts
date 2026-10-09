import type { PlatformAccount } from "@agentsales/core";
import {
  createInMemoryPlatformAccountRepository,
  createInMemoryPlatformCatalogRepository,
} from "@agentsales/core/testing";
import {
  createMercadoLibreCatalogApi,
  createMercadoLibreItems,
  createMercadoLibrePacks,
  createMercadoLibreValidator,
  createPortalCatalog,
} from "@agentsales/publishers";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ML_SMOKE_PICTURE,
  ML_SMOKE_TITLE,
  type MlSmokeDeps,
  type MlSmokeReport,
  runMlSmoke,
  smokeItems,
} from "./ml-smoke.js";

const API = "https://api.mercadolibre.com";
const NOW = new Date("2026-10-08T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const USER_ID = "8035443";
const OLD = {
  accessToken: "APP_USR-1234567890123456-100812-0f1e2d3c4b5a69788796a5b4c3d2e1f0-8035443",
  refreshToken: "TG-0f1e2d3c4b5a69788796a5b4-8035443",
};
const NEW = {
  accessToken: "APP_USR-6543210987654321-100812-aaaabbbbccccddddeeeeffff00001111-8035443",
  refreshToken: "TG-ffffeeeeddddccccbbbbaaaa-8035443",
};
const WHATSAPP = "+56 9 1234 5678";

/** Lo que recibió el Mercado Libre simulado (nunca sale a internet). */
type Recorded = { method: string; path: string; search: string; json: unknown };
const requests: Recorded[] = [];
const pending = new Set<Promise<void>>();
const server = setupServer();
server.events.on("request:start", ({ request }) => {
  const recording = (async () => {
    const text = request.method === "GET" ? "" : await request.clone().text();
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      json: text === "" ? undefined : JSON.parse(text),
    });
  })();
  pending.add(recording);
  void recording.catch(() => undefined).finally(() => pending.delete(recording));
});
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(async () => {
  await Promise.allSettled([...pending]);
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => server.close());
const recorded = async () => {
  await Promise.allSettled([...pending]);
  return requests;
};

const category = (
  id: string,
  name: string,
  children: [string, string][],
  settings: Record<string, unknown> = {},
) => ({
  id,
  name,
  children_categories: children.map(([childId, childName]) => ({ id: childId, name: childName })),
  settings: { listing_allowed: false, ...settings },
});
const LEAF = {
  listing_allowed: true,
  max_title_length: 60,
  max_pictures_per_item: 30,
  currencies: ["CLP", "CLF"],
};

/** Un árbol chico: tres hojas, una categoría sin hijas que no admite publicar. */
const CATEGORIES: Record<string, unknown> = {
  MLC1459: category("MLC1459", "Inmuebles", [
    ["MLC1472", "Departamentos"],
    ["MLC1466", "Casas"],
  ]),
  MLC1472: category("MLC1472", "Departamentos", [
    ["MLC1473", "Venta"],
    ["MLC1474", "Arriendo"],
  ]),
  MLC1473: category("MLC1473", "Venta", [
    ["MLC1480", "Propiedades Usadas"],
    ["MLC1481", "Proyectos"],
  ]),
  MLC1480: category("MLC1480", "Propiedades Usadas", [], LEAF),
  MLC1481: category("MLC1481", "Proyectos", []),
  MLC1474: category("MLC1474", "Arriendo", [["MLC1490", "Propiedades Usadas"]]),
  MLC1490: category("MLC1490", "Propiedades Usadas", [], LEAF),
  MLC1466: category("MLC1466", "Casas", [["MLC1467", "Venta"]]),
  MLC1467: category("MLC1467", "Venta", [], { ...LEAF, max_title_length: 80 }),
};

const ATTRIBUTES = [
  { id: "BEDROOMS", name: "Dormitorios", tags: { required: true }, value_type: "number" },
  {
    id: "FURNISHED",
    name: "Amoblado",
    tags: { required: true },
    value_type: "boolean",
    values: [
      { id: "242085", name: "Sí" },
      { id: "242084", name: "No" },
    ],
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
    id: "MAINTENANCE_FEE",
    name: "Gastos comunes",
    tags: { required: true },
    value_type: "number_unit",
    allowed_units: [
      { id: "USD", name: "USD" },
      { id: "CLP", name: "CLP" },
    ],
  },
  {
    id: "PROPERTY_TYPE",
    name: "Inmueble",
    tags: { required: true, read_only: true, fixed: true },
    value_type: "list",
  },
  { id: "FLOOR", name: "Piso", tags: { conditional_required: true }, value_type: "number" },
  { id: "LOT_TYPE", name: "Tipo de lote", tags: { required: true }, value_type: "list" },
  { id: "HAS_POOL", name: "Piscina", tags: {}, value_type: "boolean" },
];

const RM = "TUxDUFJNU0E";
const NUNOA = "TUxDQ05VTmE";
const COUNTRY = {
  id: "CL",
  name: "Chile",
  states: [
    { id: RM, name: "RM (Metropolitana)" },
    { id: "TUx/raro", name: "Estado raro" },
  ],
};
const STATES: Record<string, unknown> = {
  [RM]: {
    id: RM,
    name: "RM (Metropolitana)",
    cities: [
      { id: NUNOA, name: "Ñuñoa" },
      { id: "TUxD Q", name: "Ciudad con espacio" },
    ],
  },
};
const CITIES: Record<string, unknown> = {
  [NUNOA]: { id: NUNOA, name: "Ñuñoa", neighborhoods: [{ id: "TUxCTk4", name: "Plaza Ñuñoa" }] },
};

type Body = Record<string, unknown>;

/**
 * Mercado Libre simulado. `validate` responde según la variante: CLF y el título largo se
 * rechazan, sin `address_line` da un 400 sin causas (como un "sin cupo" desconocido) y el resto es
 * `204`. Crear, cambiar, cargar la descripción, ocultar la dirección y subir fotos responden bien,
 * para que una llamada no se note en la salida: solo la detecta `writes`.
 */
function useMercadoLibre(
  options: {
    unauthorized?: boolean;
    attributesDown?: string;
    validateDown?: boolean;
    /** Como la cuenta real el 2026-10-08: sin paquetes (404) y `validate` en 402 salvo el título. */
    noQuota?: boolean;
    /** Status fijo para `validate`, las categorías o los paquetes del usuario. */
    validateStatus?: number;
    categoryStatus?: number;
    userPacksStatus?: number;
  } = {},
) {
  const respond = (body: unknown) => {
    if (options.unauthorized) {
      return HttpResponse.json(
        { message: "invalid token", error: "unauthorized" },
        { status: 401 },
      );
    }
    return body === undefined
      ? HttpResponse.json({ message: "not found" }, { status: 404 })
      : HttpResponse.json(body);
  };
  server.use(
    http.get(`${API}/categories/:id/attributes`, ({ params }) =>
      params.id === options.attributesDown
        ? HttpResponse.json({ message: "boom" }, { status: 500 })
        : respond(ATTRIBUTES),
    ),
    http.get(`${API}/categories/:id/classifieds_promotion_packs`, () =>
      respond({
        results: [{ id: "PACK-1", description: "Publicaciones Plata", price: 345.1, duration: 30 }],
      }),
    ),
    http.get(`${API}/categories/:id`, ({ params }) =>
      options.categoryStatus === undefined
        ? respond(CATEGORIES[String(params.id)])
        : HttpResponse.json({ error: "forbidden" }, { status: options.categoryStatus }),
    ),
    http.get(`${API}/classified_locations/countries/CL`, () => respond(COUNTRY)),
    http.get(`${API}/classified_locations/states/:id`, ({ params }) =>
      respond(STATES[String(params.id)]),
    ),
    http.get(`${API}/classified_locations/cities/:id`, ({ params }) =>
      respond(CITIES[String(params.id)]),
    ),
    http.post(`${API}/items/validate`, async ({ request }) => {
      if (options.unauthorized) return respond(null);
      if (options.validateDown) return HttpResponse.json({ message: "boom" }, { status: 503 });
      if (options.validateStatus !== undefined) {
        return HttpResponse.json({ error: "forbidden" }, { status: options.validateStatus });
      }
      const body = (await request.json()) as Body;
      const reject = (cause: Record<string, unknown>) =>
        HttpResponse.json(
          { message: "Validation error", error: "validation_error", status: 400, cause: [cause] },
          { status: 400 },
        );
      if (String(body.title).length > 60) {
        return reject({ code: "item.title.length.invalid", cause_id: 134, type: "error" });
      }
      // Como Mercado Libre el 2026-10-08: el título se revisa antes que el cupo.
      if (options.noQuota) return new HttpResponse(null, { status: 402 });
      if (body.currency_id === "CLF") {
        return reject({ code: "item.currency_id.invalid", cause_id: 1001, type: "error" });
      }
      const location = body.location as Body;
      if (location.address_line === undefined) {
        return HttpResponse.json(
          { message: "No tienes cupo", error: "seller.without_quota", status: 400, cause: [] },
          { status: 400 },
        );
      }
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/users/:user/items/search`, () =>
      respond({
        results: ["MLC1234567890"],
        paging: { total: 1 },
        filters: [],
        available_filters: [
          {
            id: "status",
            name: "Estado",
            values: [
              { id: "active", name: "Activas", results: 1 },
              { id: "paused", name: "Pausadas", results: 0 },
            ],
          },
        ],
      }),
    ),
    http.get(`${API}/users/:user/classifieds_promotion_packs`, () =>
      options.userPacksStatus !== undefined
        ? HttpResponse.json({ message: "boom" }, { status: options.userPacksStatus })
        : options.noQuota
          ? HttpResponse.json(
              { message: "not found", error: "not_found", status: 404 },
              { status: 404 },
            )
          : respond([]),
    ),
    // Lo que el smoke nunca debe llamar: responde como Mercado Libre.
    http.post(`${API}/items`, () => HttpResponse.json({ id: "MLC1", status: "active" })),
    http.put(`${API}/items/:id`, () => HttpResponse.json({ id: "MLC1", status: "paused" })),
    http.post(`${API}/items/:id/description`, () => HttpResponse.json({})),
    http.put(`${API}/items/:id/address_line_by_reference`, () => HttpResponse.json({})),
    http.post(`${API}/pictures/items/upload`, () => HttpResponse.json({ id: "123-MLC" })),
  );
}

/** Lo que escribe en Mercado Libre: solo puede haber `POST /items/validate`. */
const writes = async () =>
  (await recorded()).filter(
    (request) => request.method !== "GET" && request.path !== "/items/validate",
  );
const validateBodies = async () =>
  (await recorded())
    .filter((request) => request.path === "/items/validate")
    .map((request) => request.json as Body);

async function setup(
  options: { connected?: boolean; whatsapp?: string | null; expiresInMs?: number } = {},
) {
  const accounts = createInMemoryPlatformAccountRepository();
  let account: PlatformAccount | null = null;
  if (options.connected !== false) {
    account = await accounts.upsertConnected({
      brokerId: "broker-1",
      platform: "portal_inmobiliario",
      externalAccountId: USER_ID,
      displayName: "VICENTEWOLDE",
      tokenExpiresAt: new Date(NOW.getTime() + 150 * DAY),
      meta: {
        userId: USER_ID,
        nickname: "VICENTEWOLDE",
        siteId: "MLC",
        userType: "normal",
        scopes: ["offline_access", "read", "write"],
        testUser: false,
        connectedAt: NOW.toISOString(),
        tokenRefreshedAt: null,
        accessTokenExpiresAt: new Date(
          NOW.getTime() + (options.expiresInMs ?? 5 * HOUR),
        ).toISOString(),
        tokenExpiryEstimated: true,
      },
      credentials: OLD,
    });
  }
  const refreshes: string[] = [];
  const catalogRepository = createInMemoryPlatformCatalogRepository();
  const lines: string[] = [];
  const errors: string[] = [];
  const reports: MlSmokeReport[] = [];
  const deps: MlSmokeDeps = {
    accounts,
    brokers: {
      list: async () => [
        {
          id: "broker-1",
          slug: "agentsales-pruebas",
          name: "Corredora de Prueba",
          email: "contacto@corredor.test",
          whatsapp: options.whatsapp === undefined ? WHATSAPP : options.whatsapp,
        },
      ],
    },
    listings: {
      list: async () => [
        {
          id: "l2",
          brokerId: "broker-1",
          externalRef: "P002",
          region: "Metropolitana",
          comuna: "Inventada",
        },
        {
          id: "l1",
          brokerId: "broker-1",
          externalRef: "P001",
          region: "Región Metropolitana",
          comuna: "ñuñoa",
        },
        { id: "l3", brokerId: "broker-1", externalRef: "P003", region: null, comuna: null },
        {
          id: "l9",
          brokerId: "broker-9",
          externalRef: "X001",
          region: "Metropolitana",
          comuna: "Ñuñoa",
        },
      ],
    },
    mercadoLibre: {
      async refresh(refreshToken) {
        refreshes.push(refreshToken);
        return {
          ...NEW,
          accessTokenExpiresAt: new Date(NOW.getTime() + 6 * HOUR),
          scopes: ["offline_access", "read", "write"],
          userId: USER_ID,
        };
      },
    },
    catalog: createPortalCatalog({
      api: createMercadoLibreCatalogApi(),
      repository: catalogRepository,
      now: () => NOW,
      aliases: { regions: { metropolitana: "RM (Metropolitana)" }, communes: {} },
    }),
    validator: createMercadoLibreValidator(),
    items: smokeItems(createMercadoLibreItems()),
    packs: createMercadoLibrePacks(),
    async writeReport(report) {
      reports.push(structuredClone(report));
      return "tmp/ml-smoke/informe.json";
    },
    now: () => NOW,
    print: (line) => lines.push(line),
    printError: (line) => errors.push(line),
  };
  const output = () => [...lines, ...errors].join("\n");
  return { deps, accounts, account, catalogRepository, refreshes, lines, errors, reports, output };
}

/** Nada con forma de token ni el WhatsApp del corredor, en la salida ni en el informe. */
function expectNoSecrets(text: string) {
  for (const secret of [...Object.values(OLD), ...Object.values(NEW), "912345678", "1234 5678"]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/APP_USR-|TG-/);
}

describe("runMlSmoke", () => {
  it("recorre, valida y lee: nunca sube una foto ni crea o cambia un ítem (solo GET y validate)", async () => {
    useMercadoLibre();
    const { deps, catalogRepository, reports, output, accounts, account } = await setup();

    const code = await runMlSmoke(deps);

    expect(code).toBe(0);
    expect(await writes()).toEqual([]);
    const methods = new Set(
      (await recorded()).map((request) => `${request.method} ${request.path}`),
    );
    expect([...methods].filter((call) => !call.startsWith("GET "))).toEqual([
      "POST /items/validate",
    ]);
    // Escribe el catálogo en la base (7 días), y no refrescó: el token tenía 5 h.
    expect(catalogRepository.keys()).toEqual(
      expect.arrayContaining(["category:MLC1459", "attributes:MLC1480", `location:${RM}`]),
    );
    expect(accounts.storedCredentials(account?.id ?? "")).toEqual(OLD);
    expect(output()).toContain("✓ Listo. No se creó ni se cambió nada en Mercado Libre");
    expect(output()).toContain("Informe completo: tmp/ml-smoke/informe.json");
    expect(reports).toHaveLength(1);
    expectNoSecrets(`${output()}\n${JSON.stringify(reports)}`);
  });

  it("las hojas con sus settings, obligatorios, condicionales y tags, y la búsqueda por nombres", async () => {
    useMercadoLibre();
    const { deps, reports, lines } = await setup();

    await runMlSmoke(deps);

    const { categories } = reports[0] as MlSmokeReport;
    expect(categories.leaves.map((leaf) => [leaf.path.join(" > "), leaf.id, leaf.byName])).toEqual([
      ["Departamentos > Venta > Propiedades Usadas", "MLC1480", "ok"],
      ["Departamentos > Arriendo > Propiedades Usadas", "MLC1490", "ok"],
      ["Casas > Venta", "MLC1467", "ok"],
    ]);
    expect(categories.deadEnds).toEqual([
      { path: ["Departamentos", "Venta", "Proyectos"], id: "MLC1481" },
    ]);
    expect(categories.visited).toBe(9);
    expect(categories.leaves[0]?.required.map((attribute) => attribute.id)).toEqual([
      "BEDROOMS",
      "FURNISHED",
      "COVERED_AREA",
      "MAINTENANCE_FEE",
      "PROPERTY_TYPE",
      "LOT_TYPE",
    ]);
    expect(categories.leaves[0]?.conditional.map((attribute) => attribute.id)).toEqual(["FLOOR"]);
    expect(categories.leaves[0]?.tagged.map((attribute) => attribute.id)).toEqual([
      "PROPERTY_TYPE",
    ]);
    expect(categories.requiredTags).toEqual({
      read_only: ["PROPERTY_TYPE"],
      fixed: ["PROPERTY_TYPE"],
    });
    expect(lines).toContain(
      "  Departamentos > Venta > Propiedades Usadas · MLC1480 · título 60 · fotos 30 · monedas CLP, CLF",
    );
    expect(lines).toContain(
      "    obligatorios: BEDROOMS, FURNISHED, COVERED_AREA, MAINTENANCE_FEE, PROPERTY_TYPE[read_only,fixed], LOT_TYPE",
    );
    expect(lines).toContain("  3 hojas en 9 categorías; largo del título: 60, 80");
  });

  it("compara la tabla de obligatorios de Portal con las hojas reales y muestra las diferencias", async () => {
    useMercadoLibre();
    const { deps, reports, errors } = await setup();

    await runMlSmoke(deps);

    const check = (reports[0] as MlSmokeReport).categories.tableCheck;
    // La hoja de muestra de departamentos en venta pide FURNISHED, MAINTENANCE_FEE y LOT_TYPE, y no
    // pide TOTAL_AREA, FULL_BATHROOMS ni PARKING_LOTS (la tabla, sí).
    expect(check.find((diff) => diff.leafId === "MLC1480")).toEqual({
      path: ["Departamentos", "Venta", "Propiedades usadas"],
      leafId: "MLC1480",
      onlyTable: ["FULL_BATHROOMS", "PARKING_LOTS", "TOTAL_AREA"],
      onlyLeaf: ["FURNISHED", "MAINTENANCE_FEE", "LOT_TYPE"],
    });
    // Los tipos que el árbol de muestra no tiene: la hoja no apareció.
    expect(check).toContainEqual(
      expect.objectContaining({ path: ["Locales", "Venta"], leafId: null }),
    );
    expect(errors).toContain(
      "  Tabla de Portal: no calza con las hojas reales (ponla al día en core, portal/fields.ts):",
    );
    expect(errors).toContain(
      "    Departamentos > Venta > Propiedades usadas: la tabla pide de más: FULL_BATHROOMS, PARKING_LOTS, TOTAL_AREA; Mercado Libre pide además: FURNISHED, MAINTENANCE_FEE, LOT_TYPE",
    );
    // Es información para poner la tabla al día: no es un error del smoke.
    expect((reports[0] as MlSmokeReport).errors).toEqual([]);
  });

  it("revisa la forma de los ids de ubicación y ubica los avisos del corredor (con alias)", async () => {
    useMercadoLibre();
    const { deps, reports, errors, lines } = await setup();

    await runMlSmoke(deps);

    const { locations } = reports[0] as MlSmokeReport;
    expect(locations.states.map((state) => [state.name, state.validId])).toEqual([
      ["RM (Metropolitana)", true],
      ["Estado raro", false],
    ]);
    expect(locations.states[0]?.cities.map((city) => city.validId)).toEqual([true, false]);
    expect(errors).toContain(
      "  ✗ Estado raro: su id no tiene la forma esperada (no se puede leer)",
    );
    expect(errors).toContain("    ✗ ids con otra forma: Ciudad con espacio");
    expect(locations.listings).toEqual([
      {
        externalRef: "P001",
        region: "Región Metropolitana",
        commune: "ñuñoa",
        match: { state: "RM (Metropolitana)", city: "Ñuñoa", neighborhood: null },
        error: null,
      },
      {
        externalRef: "P002",
        region: "Metropolitana",
        commune: "Inventada",
        match: null,
        error: "PORTAL_LOCATION_NOT_FOUND",
      },
      { externalRef: "P003", region: null, commune: null, match: null, error: "SIN_UBICACION" },
    ]);
    expect(locations.sampleCity).toEqual({
      id: NUNOA,
      name: "Ñuñoa",
      neighborhoods: [{ id: "TUxCTk4", name: "Plaza Ñuñoa" }],
    });
    expect(lines).toContain("      Ñuñoa tiene 1 barrios en Mercado Libre");
    // Un aviso que no calza es un resultado, no un error del smoke.
    expect((reports[0] as MlSmokeReport).errors).toEqual([]);
  });

  it("el aviso de prueba y sus variantes van a validate, con la ubicación real y sin barrio", async () => {
    useMercadoLibre();
    const { deps, reports, lines } = await setup();

    await runMlSmoke(deps);

    const bodies = await validateBodies();
    expect(bodies).toHaveLength(7);
    const [base, noAddress, description, shortSite, noSite, clf, longTitle] = bodies;
    expect(base).toMatchObject({
      title: ML_SMOKE_TITLE,
      category_id: "MLC1480",
      price: 150_000_000,
      currency_id: "CLP",
      available_quantity: 1,
      buying_mode: "classified",
      listing_type_id: "silver",
      condition: "not_specified",
      channels: ["marketplace"],
      pictures: [{ source: ML_SMOKE_PICTURE }],
      location: {
        address_line: "Calle de Prueba 123",
        country: { id: "CL" },
        state: { id: RM },
        city: { id: NUNOA },
      },
      seller_contact: {
        contact: "Corredora de Prueba",
        email: "contacto@corredor.test",
        country_code2: "56",
        phone2: "912345678",
      },
    });
    expect(base?.location).not.toHaveProperty("neighborhood");
    expect(base?.description).toBeUndefined();
    expect(base?.attributes).toEqual([
      { id: "BEDROOMS", value_name: "2" },
      { id: "FURNISHED", value_id: "242084" },
      { id: "COVERED_AREA", value_name: "60 m²" },
      { id: "MAINTENANCE_FEE", value_name: "80000 CLP" },
      {
        id: "CMG_SITE",
        name: "Site de origen",
        value_id: null,
        value_name: "POI",
        value_struct: null,
        attribute_group_id: "OTHERS",
        attribute_group_name: "Otros",
      },
    ]);
    expect(noAddress?.location).toEqual({
      country: { id: "CL" },
      state: { id: RM },
      city: { id: NUNOA },
    });
    expect(description?.description).toEqual({
      plain_text: "Aviso de prueba de AgentSales: no publicar.",
    });
    expect((shortSite?.attributes as Body[] | undefined)?.at(-1)).toEqual({
      id: "CMG_SITE",
      value_name: "POI",
    });
    expect(
      (noSite?.attributes as Body[] | undefined)?.map((attribute) => attribute.id),
    ).not.toContain("CMG_SITE");
    expect(clf).toMatchObject({ price: 5800.25, currency_id: "CLF" });
    expect(String(longTitle?.title)).toHaveLength(61);

    const { validate } = reports[0] as MlSmokeReport;
    expect(validate.leaf).toEqual({
      id: "MLC1480",
      path: ["Departamentos", "Venta", "Propiedades Usadas"],
    });
    expect(validate.missingSamples).toEqual(["FLOOR", "LOT_TYPE"]);
    expect(validate.contact).toBe("broker");
    expect(validate.variants.map((variant) => [variant.name, variant.valid])).toEqual([
      ["base (CLP, con dirección y CMG_SITE completo)", true],
      ["sin address_line", null],
      ["descripción en el cuerpo", true],
      ["CMG_SITE corto", true],
      ["sin CMG_SITE", true],
      ["CLF (UF con 2 decimales)", false],
      ["título de 61 caracteres", false],
    ]);
    // Un 400 sin causas (como un "sin cupo" que no se conoce) muestra su código tal cual.
    expect(validate.variants[1]?.error).toMatchObject({
      code: "ML_REQUEST_REJECTED",
      details: { httpStatus: 400, error: "seller.without_quota" },
    });
    expect(lines).toContain(
      "  sin address_line: ✗ ML_REQUEST_REJECTED (HTTP 400; error seller.without_quota)",
    );
    expect(validate.variants[5]?.errors).toEqual([
      { code: "item.currency_id.invalid", causeId: 1001, type: "error" },
    ]);
    expect(lines).toContain(
      "  CLF (UF con 2 decimales): rechazado: item.currency_id.invalid #1001 error",
    );
    expect(lines).toContain("  Contacto: el del corredor (WhatsApp +56 9 ****5678)");
  });

  it("sin paquetes (como la cuenta real): 404 de paquetes y 402 de validate son resultados, con la pista", async () => {
    useMercadoLibre({ noQuota: true });
    const { deps, reports, lines } = await setup();

    expect(await runMlSmoke(deps)).toBe(0);

    const report = reports[0] as MlSmokeReport;
    expect(report.errors).toEqual([]);
    expect(report.packs).toMatchObject({ user: null, userNotFound: true });
    expect(lines).toContain(
      "  Contratados por la cuenta: ninguno (Mercado Libre respondió 404 not_found)",
    );
    expect(report.validate.variants.map((variant) => variant.error?.code ?? variant.valid)).toEqual(
      [
        "ML_NO_QUOTA",
        "ML_NO_QUOTA",
        "ML_NO_QUOTA",
        "ML_NO_QUOTA",
        "ML_NO_QUOTA",
        "ML_NO_QUOTA",
        false,
      ],
    );
    expect(lines).toContain(
      "  base (CLP, con dirección y CMG_SITE completo): ✗ ML_NO_QUOTA (HTTP 402)",
    );
    expect(lines).toContain(
      "  → Sin un paquete silver con cupo, Mercado Libre responde 402 y no revisa el resto del aviso (sí el título): contrátalo antes de la prueba con paquete",
    );
  });

  it("sin WhatsApp del corredor, usa un contacto de muestra y lo dice", async () => {
    useMercadoLibre();
    const { deps, reports, lines } = await setup({ whatsapp: null });

    await runMlSmoke(deps);

    expect((await validateBodies())[0]?.seller_contact).toEqual({
      contact: "AgentSales ml:smoke",
      country_code2: "56",
      phone2: "900000000",
    });
    expect(reports[0]?.validate.contact).toBe("sample");
    expect(lines).toContain(
      "  Contacto: uno de muestra (el corredor no tiene WhatsApp en su hoja)",
    );
  });

  it("--category elige la hoja; una que no se recorrió no se valida y sale con 1", async () => {
    useMercadoLibre();
    const first = await setup();
    await runMlSmoke(first.deps, { categoryId: "MLC1467" });
    expect((await validateBodies())[0]?.category_id).toBe("MLC1467");
    expect(String((await validateBodies()).at(-1)?.title)).toHaveLength(81);

    requests.length = 0;
    const second = await setup();
    const code = await runMlSmoke(second.deps, { categoryId: "MLC9999" });
    expect(code).toBe(1);
    expect(await validateBodies()).toEqual([]);
    expect(second.reports[0]?.errors).toEqual([
      {
        section: "validate",
        code: "ML_SMOKE_LEAF_NOT_FOUND",
        message: "MLC9999 no es una de las hojas recorridas",
      },
    ]);
  });

  it("la búsqueda sin status con sus filtros, y los paquetes contratados y para contratar", async () => {
    useMercadoLibre();
    const { deps, reports, lines } = await setup();

    await runMlSmoke(deps);

    const search = (await recorded()).find((request) => request.path.endsWith("/items/search"));
    expect(search?.path).toBe(`/users/${USER_ID}/items/search`);
    expect(search?.search).toBe("?include_filters=true");
    expect(reports[0]?.search?.availableFilters).toEqual([
      {
        id: "status",
        values: [
          { id: "active", name: "Activas", results: 1 },
          { id: "paused", name: "Pausadas", results: 0 },
        ],
      },
    ]);
    expect(lines).toContain("  Estados disponibles: status: active (1), paused (0)");
    expect(lines).toContain("  Contratados por la cuenta: 0");
    expect(lines).toContain('  Para contratar en Inmuebles (MLC1459): 1 (en "results")');
    expect(lines).toContain("    Publicaciones Plata · precio 345.1 · 30 días");
  });

  it("un 401 que se repite después de refrescar: lo informa, sale con 1 y no marca la cuenta", async () => {
    useMercadoLibre({ unauthorized: true });
    const { deps, accounts, account, refreshes, errors, reports, output } = await setup();

    const code = await runMlSmoke(deps);

    expect(code).toBe(1);
    // Refrescó una vez (el par rotó y quedó guardado) y paró: nada después del segundo 401.
    expect(refreshes).toEqual([OLD.refreshToken]);
    expect(accounts.storedCredentials(account?.id ?? "")).toEqual(NEW);
    expect((await recorded()).map((request) => request.path)).toEqual([
      "/categories/MLC1459",
      "/categories/MLC1459",
    ]);
    expect((await accounts.get(account?.id ?? ""))?.status).toBe("connected");
    expect(errors).toContain(
      "  → Mercado Libre rechazó el acceso aun después de renovarlo. ml:smoke no marca la cuenta como vencida: revisa pnpm -s cli accounts y, si sigue, reconéctala",
    );
    expect(reports[0]?.errors).toEqual([
      expect.objectContaining({
        section: "stop",
        code: "ML_AUTH_INVALID",
        details: expect.objectContaining({ httpStatus: 401, reason: "rejected_after_refresh" }),
      }),
    ]);
    expectNoSecrets(`${output()}\n${JSON.stringify(reports)}`);
  });

  it("con el acceso por vencer, lo renueva antes de empezar (con el candado) y sigue", async () => {
    useMercadoLibre();
    const { deps, accounts, account, refreshes } = await setup({ expiresInMs: 10 * 60 * 1000 });

    expect(await runMlSmoke(deps)).toBe(0);
    expect(refreshes).toEqual([OLD.refreshToken]);
    expect(accounts.storedCredentials(account?.id ?? "")).toEqual(NEW);
  });

  it("sin el par de la app y con el acceso por vencer: lo dice sin llamar y sin cambiar la cuenta", async () => {
    useMercadoLibre();
    const { deps, accounts, account, errors } = await setup({ expiresInMs: 0 });

    const code = await runMlSmoke({ ...deps, mercadoLibre: null });

    expect(code).toBe(1);
    expect(await recorded()).toEqual([]);
    expect((await accounts.get(account?.id ?? ""))?.status).toBe("connected");
    expect(errors).toContain("  → Falta ML_APP_ID o ML_CLIENT_SECRET en .env (pnpm -s cli doctor)");
  });

  it("sin cuenta conectada: la pista para conectarla, sin llamar ni escribir el informe", async () => {
    useMercadoLibre();
    const { deps, errors, reports } = await setup({ connected: false });

    expect(await runMlSmoke(deps)).toBe(1);
    expect(errors).toEqual([
      "✗ ACCOUNT_NOT_CONNECTED: No hay una cuenta de Mercado Libre conectada",
      "  → Conecta la cuenta (con pnpm dev): pnpm -s cli accounts connect mercadolibre --broker <slug>",
    ]);
    expect(await recorded()).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("una lectura que falla no corta las demás: queda en el informe y sale con 1", async () => {
    useMercadoLibre({ attributesDown: "MLC1490", validateDown: true });
    const { deps, reports, errors } = await setup();

    const code = await runMlSmoke(deps);

    expect(code).toBe(1);
    const report = reports[0] as MlSmokeReport;
    expect(report.categories.leaves).toHaveLength(3);
    // Un validate caído no enseña nada: cuenta como error (un rechazo, no).
    expect(report.errors.map((error) => [error.section, error.code])).toEqual([
      ["attributes:MLC1490", "ML_UNAVAILABLE"],
      ...report.validate.variants.map((variant) => [`validate:${variant.name}`, "ML_UNAVAILABLE"]),
    ]);
    expect(report.validate.variants).toHaveLength(7);
    expect(report.search).not.toBeNull();
    expect(errors).toContain("✗ 8 lectura(s) fallaron: revisa los ✗ de arriba");
  });

  it("un 403 en validate no es un resultado: error con su pista y sale con 1", async () => {
    useMercadoLibre({ validateStatus: 403 });
    const { deps, reports, errors, lines } = await setup();

    expect(await runMlSmoke(deps)).toBe(1);

    const report = reports[0] as MlSmokeReport;
    expect(report.errors).toHaveLength(7);
    expect(report.errors.every((error) => error.code === "ML_PERMISSION_DENIED")).toBe(true);
    expect(lines).toContain(
      "  base (CLP, con dirección y CMG_SITE completo): ✗ no se pudo validar",
    );
    expect(errors).toContain(
      "    → Revisa que la app tenga el permiso de publicación y que autorizó la cuenta administradora",
    );
  });

  it("el recorrido se corta en el tope, y un 403 en Inmuebles no deja nada más que recorrer", async () => {
    useMercadoLibre();
    const capped = await setup();
    await runMlSmoke(capped.deps, { maxCategories: 3 });
    expect(capped.reports[0]?.categories).toMatchObject({ visited: 3, truncated: true });
    expect(capped.errors).toContain("  Aviso: se cortó el recorrido en 3 categorías");

    requests.length = 0;
    server.resetHandlers();
    useMercadoLibre({ categoryStatus: 403 });
    const denied = await setup();
    expect(await runMlSmoke(denied.deps)).toBe(1);
    const categoryCalls = (await recorded()).filter((request) =>
      /^\/categories\/MLC\d+$/.test(request.path),
    );
    expect(categoryCalls).toHaveLength(1);
    expect(denied.reports[0]?.errors[0]).toMatchObject({
      section: "category:MLC1459",
      code: "ML_PERMISSION_DENIED",
    });
  });

  it("deja de insistir tras 3 categorías seguidas con error (un 403 se repetiría en todas)", async () => {
    useMercadoLibre();
    const children: [string, string][] = [
      ["MLC1", "Uno"],
      ["MLC2", "Dos"],
      ["MLC3", "Tres"],
      ["MLC4", "Cuatro"],
    ];
    server.use(
      http.get(`${API}/categories/:id`, ({ params }) =>
        params.id === "MLC1459"
          ? HttpResponse.json(category("MLC1459", "Inmuebles", children))
          : HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );
    const { deps, reports, errors } = await setup();

    expect(await runMlSmoke(deps)).toBe(1);
    expect(reports[0]?.categories).toMatchObject({ visited: 4, truncated: true });
    const categoryCalls = (await recorded())
      .map((request) => request.path)
      .filter((path) => /^\/categories\/MLC\d+$/.test(path));
    expect(categoryCalls).toEqual([
      "/categories/MLC1459",
      "/categories/MLC1",
      "/categories/MLC2",
      "/categories/MLC3",
    ]);
    expect(errors).toContain(
      "  Aviso: se cortó el recorrido después de 3 categorías seguidas con error",
    );
  });

  it("Ctrl-C (la señal) corta todo: ML_ABORTED, sin seguir llamando, y sale con 1", async () => {
    useMercadoLibre();
    const { deps, errors } = await setup();
    const controller = new AbortController();
    controller.abort();

    expect(await runMlSmoke(deps, { signal: controller.signal })).toBe(1);
    expect(await recorded()).toEqual([]);
    expect(errors[0]).toMatch(/^✗ ML_ABORTED: /);
  });

  it("una caída de los paquetes del usuario (500) sí es un error", async () => {
    useMercadoLibre({ userPacksStatus: 500 });
    const { deps, reports } = await setup();

    expect(await runMlSmoke(deps)).toBe(1);
    expect(reports[0]?.packs.userNotFound).toBe(false);
    expect(reports[0]?.errors).toEqual([
      expect.objectContaining({ section: "packs:user", code: "ML_UNAVAILABLE" }),
    ]);
  });

  it("smokeItems solo expone la búsqueda", () => {
    expect(Object.keys(smokeItems(createMercadoLibreItems()))).toEqual(["searchItems"]);
  });
});
