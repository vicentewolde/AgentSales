import type {
  AbortSignalLike,
  EnsureAccessTokenOptions,
  PortalLocationAliases,
} from "@agentsales/core";
import { createInMemoryPlatformCatalogRepository } from "@agentsales/core/testing";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import {
  createPortalCatalog,
  type PortalCatalogContext,
  type PortalCatalogNote,
} from "./catalog.js";
import { createMercadoLibreCatalogApi } from "./catalog-api.js";

const API = "https://api.mercadolibre.com";
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const { server, recorded } = usePlatformServer();

/** Una categoría de muestra como la manda Mercado Libre. */
const category = (
  id: string,
  name: string,
  children: [string, string][],
  settings: Record<string, unknown> = {},
) => ({
  id,
  name,
  children_categories: children.map(([childId, childName]) => ({
    id: childId,
    name: childName,
    total_items_in_this_category: 10,
  })),
  settings: { listing_allowed: false, max_pictures_per_item: 30, ...settings },
});

/** Un árbol de muestra: Inmuebles > Departamentos > Venta > Propiedades Usadas (hoja), y más. */
const CATEGORIES: Record<string, unknown> = {
  MLC1459: category("MLC1459", "Inmuebles", [
    ["MLC1472", "Departamentos"],
    ["MLC1466", "Casas"],
    ["MLC1500", "Oficinas"],
    ["MLC1501", "OFICINAS"],
  ]),
  MLC1472: category("MLC1472", "Departamentos", [
    ["MLC1473", "Venta"],
    ["MLC1474", "Arriendo"],
  ]),
  MLC1473: category("MLC1473", "Venta", [
    ["MLC1480", "Propiedades Usadas"],
    ["MLC1481", "Proyectos"],
  ]),
  MLC1480: category("MLC1480", "Propiedades Usadas", [], {
    listing_allowed: true,
    max_title_length: 60,
    currencies: ["CLP", "CLF"],
  }),
  // Sin hijas, pero sin `listing_allowed`: no es una hoja.
  MLC1474: category("MLC1474", "Arriendo", []),
};

const ATTRIBUTES = [
  { id: "BEDROOMS", name: "Dormitorios", tags: { required: true }, value_type: "number" },
  {
    id: "IS_SUITABLE_FOR_PETS",
    name: "Admite mascotas",
    tags: { required: true },
    value_type: "boolean",
    values: [
      { id: "242085", name: "Sí" },
      { id: "242084", name: "No" },
    ],
  },
];

const RM = "TUxDUFJNU0E";
const OHIGGINS = "TUxDUE9IUzFjODg";
const SANTIAGO = "TUxDQ1NBTmE";
const COUNTRY = {
  id: "CL",
  name: "Chile",
  states: [
    { id: OHIGGINS, name: "Libertador B. O'Higgins" },
    { id: RM, name: "RM (Metropolitana)" },
  ],
};
const STATES: Record<string, unknown> = {
  [RM]: {
    id: RM,
    name: "RM (Metropolitana)",
    cities: [
      { id: "TUxDQ05VTmE", name: "Ñuñoa" },
      { id: "TUxDQ1BFTmE", name: "Peñalolén" },
      { id: SANTIAGO, name: "Santiago" },
    ],
  },
  [OHIGGINS]: {
    id: OHIGGINS,
    name: "Libertador B. O'Higgins",
    cities: [{ id: "TUxDQ0xBWmE0Y2Zm", name: "La Estrella" }],
  },
};
const CITIES: Record<string, unknown> = {
  [SANTIAGO]: {
    id: SANTIAGO,
    name: "Santiago",
    neighborhoods: [
      { id: "TUxDQlBST3Y", name: "Providencia" },
      { id: "TUxDQkxBUw", name: "Las Condes" },
    ],
  },
};

const ALIASES: PortalLocationAliases = {
  regions: { metropolitana: "RM (Metropolitana)" },
  communes: {
    providencia: { city: "Santiago", neighborhood: "Providencia" },
    "santiago centro": { city: "Santiago" },
    "las condes": { city: "Santiago", neighborhood: "No existe" },
  },
};

/** Mercado Libre simulado: responde el árbol y las ubicaciones de muestra; `down` da un 500. */
function useMercadoLibre(options: { down?: boolean; rejectFirst?: number } = {}) {
  let rejections = options.rejectFirst ?? 0;
  const respond = (body: unknown) => {
    if (options.down) return HttpResponse.json({ message: "boom" }, { status: 500 });
    if (rejections > 0) {
      rejections -= 1;
      return HttpResponse.json(
        { message: "invalid access token", error: "unauthorized", status: 401 },
        { status: 401 },
      );
    }
    return body === undefined
      ? HttpResponse.json({ message: "not found" }, { status: 404 })
      : HttpResponse.json(body);
  };
  server.use(
    http.get(`${API}/categories/:id/attributes`, () => respond(ATTRIBUTES)),
    http.get(`${API}/categories/:id`, ({ params }) => respond(CATEGORIES[String(params.id)])),
    http.get(`${API}/classified_locations/countries/CL`, () => respond(COUNTRY)),
    http.get(`${API}/classified_locations/states/:id`, ({ params }) =>
      respond(STATES[String(params.id)]),
    ),
    http.get(`${API}/classified_locations/cities/:id`, ({ params }) =>
      respond(CITIES[String(params.id)]),
    ),
  );
}

function setup() {
  let clock = NOW;
  const repository = createInMemoryPlatformCatalogRepository();
  const notes: PortalCatalogNote[] = [];
  const tokenCalls: EnsureAccessTokenOptions[] = [];
  const ctx: PortalCatalogContext = {
    accessToken: async (options = {}) => {
      tokenCalls.push(options);
      return `APP_USR-token-${tokenCalls.length}`;
    },
  };
  const catalog = createPortalCatalog({
    api: createMercadoLibreCatalogApi(),
    repository,
    now: () => clock,
    aliases: ALIASES,
    onNote: (note) => notes.push(note),
  });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const paths = async () => (await recorded()).map((request) => request.url.pathname);
  return { catalog, repository, notes, tokenCalls, ctx, advance, paths };
}

const LEAF_PATH = ["departamentos", "VENTA", "propiedades usadas"];

describe("leafCategory", () => {
  it("baja por los nombres (sin mayúsculas ni tildes) hasta la hoja, y solo lo necesario", async () => {
    useMercadoLibre();
    const { catalog, repository, ctx, paths } = setup();

    const leaf = await catalog.leafCategory(LEAF_PATH, ctx);

    expect(leaf).toMatchObject({
      id: "MLC1480",
      name: "Propiedades Usadas",
      settings: { listingAllowed: true, maxTitleLength: 60, currencies: ["CLP", "CLF"] },
    });
    expect(await paths()).toEqual([
      "/categories/MLC1459",
      "/categories/MLC1472",
      "/categories/MLC1473",
      "/categories/MLC1480",
    ]);
    expect(repository.keys().sort()).toEqual([
      "category:MLC1459",
      "category:MLC1472",
      "category:MLC1473",
      "category:MLC1480",
    ]);
  });

  it("lo guardado sirve 7 días sin llamar; a los 7 días se baja de nuevo", async () => {
    useMercadoLibre();
    const { catalog, ctx, advance, paths, tokenCalls } = setup();
    await catalog.leafCategory(LEAF_PATH, ctx);

    advance(7 * DAY - 1);
    await catalog.leafCategory(LEAF_PATH, ctx);
    expect(await paths()).toHaveLength(4);
    expect(tokenCalls).toHaveLength(4);

    advance(1);
    await catalog.leafCategory(LEAF_PATH, ctx);
    expect(await paths()).toHaveLength(8);
  });

  it("si Mercado Libre no responde, usa la copia vencida y avisa; sin copia, el error sube", async () => {
    useMercadoLibre();
    const { catalog, ctx, advance, notes } = setup();
    await catalog.leafCategory(LEAF_PATH, ctx);
    advance(30 * DAY);
    server.resetHandlers();
    useMercadoLibre({ down: true });

    await expect(catalog.leafCategory(LEAF_PATH, ctx)).resolves.toMatchObject({ id: "MLC1480" });
    expect(notes).toEqual([
      { code: "PORTAL_CATALOG_STALE", key: "category:MLC1459", errorCode: "ML_UNAVAILABLE" },
      { code: "PORTAL_CATALOG_STALE", key: "category:MLC1472", errorCode: "ML_UNAVAILABLE" },
      { code: "PORTAL_CATALOG_STALE", key: "category:MLC1473", errorCode: "ML_UNAVAILABLE" },
      { code: "PORTAL_CATALOG_STALE", key: "category:MLC1480", errorCode: "ML_UNAVAILABLE" },
    ]);

    const empty = setup();
    await expect(empty.catalog.leafCategory(LEAF_PATH, empty.ctx)).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
  });

  it("una entrada guardada con otra forma se baja de nuevo; si falla, no hay copia que usar", async () => {
    useMercadoLibre();
    const { catalog, repository, ctx, paths } = setup();
    await catalog.leafCategory(LEAF_PATH, ctx);
    repository.corrupt("portal_inmobiliario", "category:MLC1473", { id: "MLC1473" });

    await catalog.leafCategory(LEAF_PATH, ctx);
    expect((await paths()).slice(4)).toEqual(["/categories/MLC1473"]);

    repository.corrupt("portal_inmobiliario", "category:MLC1473", { id: "MLC1473" });
    server.resetHandlers();
    useMercadoLibre({ down: true });
    await expect(catalog.leafCategory(LEAF_PATH, ctx)).rejects.toMatchObject({
      code: "ML_UNAVAILABLE",
    });
  });

  it("un corte pedido (señal) no usa la copia vencida", async () => {
    useMercadoLibre();
    const { catalog, ctx, advance, notes } = setup();
    await catalog.leafCategory(LEAF_PATH, ctx);
    advance(8 * DAY);
    const signal: AbortSignalLike = {
      aborted: true,
      addEventListener() {},
      removeEventListener() {},
    };

    await expect(catalog.leafCategory(LEAF_PATH, { ...ctx, signal })).rejects.toMatchObject({
      code: "ML_ABORTED",
    });
    expect(notes).toEqual([]);
  });

  it.each([
    [["Bodegas"], "missing"],
    [["Oficinas", "Venta"], "ambiguous"],
    [["Departamentos", "Arriendo"], "not_leaf"],
    [["Departamentos", "Venta"], "not_leaf"],
    [[], "empty"],
  ])("%j: PORTAL_CATEGORY_NOT_FOUND (%s)", async (path, reason) => {
    useMercadoLibre();
    const { catalog, ctx } = setup();

    await expect(catalog.leafCategory(path, ctx)).rejects.toMatchObject({
      code: "PORTAL_CATEGORY_NOT_FOUND",
      retriable: false,
      details: { reason },
    });
  });

  it("un token rechazado (401) se pide de nuevo una vez con el rechazado; un segundo 401 sube", async () => {
    useMercadoLibre({ rejectFirst: 1 });
    const { catalog, ctx, tokenCalls } = setup();

    await expect(catalog.leafCategory(["Departamentos"], ctx)).rejects.toMatchObject({
      code: "PORTAL_CATEGORY_NOT_FOUND",
    });
    expect(tokenCalls.slice(0, 2)).toEqual([{}, { rejectedToken: "APP_USR-token-1" }]);
    const requests = await recorded();
    expect(requests.slice(0, 2).map((request) => request.authorization)).toEqual([
      "Bearer APP_USR-token-1",
      "Bearer APP_USR-token-2",
    ]);

    server.resetHandlers();
    useMercadoLibre({ rejectFirst: 2 });
    const twice = setup();
    const error = await twice.catalog.leafCategory(LEAF_PATH, twice.ctx).catch((e) => e);
    expect(error).toMatchObject({ code: "ML_AUTH_INVALID" });
    expect(twice.tokenCalls).toHaveLength(2);
    expect(errorText(error)).not.toContain("APP_USR");
  });

  it("si no se puede guardar, avisa y usa lo bajado", async () => {
    useMercadoLibre();
    const { repository, notes, ctx } = setup();
    const catalog = createPortalCatalog({
      api: createMercadoLibreCatalogApi(),
      repository: {
        get: repository.get,
        put: async () => {
          throw Object.assign(new Error("sin base"), { code: "DB_UNAVAILABLE" });
        },
      },
      now: () => NOW,
      onNote: (note) => notes.push(note),
    });

    await expect(
      catalog.leafCategory(["Departamentos", "Venta", "Propiedades Usadas"], ctx),
    ).resolves.toMatchObject({ id: "MLC1480" });
    expect(notes[0]).toEqual({
      code: "PORTAL_CATALOG_NOT_SAVED",
      key: "category:MLC1459",
      errorCode: "INTERNAL_ERROR",
    });
  });
});

describe("attributes", () => {
  it("los atributos de la hoja, guardados por 7 días", async () => {
    useMercadoLibre();
    const { catalog, repository, ctx, paths } = setup();

    const attributes = await catalog.attributes("MLC1480", ctx);
    await catalog.attributes("MLC1480", ctx);

    expect(attributes.map((attribute) => [attribute.id, attribute.required])).toEqual([
      ["BEDROOMS", true],
      ["IS_SUITABLE_FOR_PETS", true],
    ]);
    expect(attributes[1]?.values).toEqual([
      { id: "242085", name: "Sí" },
      { id: "242084", name: "No" },
    ]);
    expect(await paths()).toEqual(["/categories/MLC1480/attributes"]);
    expect(repository.keys()).toEqual(["attributes:MLC1480"]);
  });
});

describe("location", () => {
  it("la comuna entre las ciudades del estado, sin mayúsculas ni tildes; solo baja Chile y ese estado", async () => {
    useMercadoLibre();
    const { catalog, ctx, paths } = setup();

    const place = await catalog.location({ region: "Región Metropolitana", commune: "ÑUÑOA" }, ctx);
    const again = await catalog.location({ region: "metropolitana", commune: "penalolen" }, ctx);

    expect(place).toEqual({
      state: { id: RM, name: "RM (Metropolitana)" },
      city: { id: "TUxDQ05VTmE", name: "Ñuñoa" },
      neighborhood: null,
    });
    expect(again.city).toEqual({ id: "TUxDQ1BFTmE", name: "Peñalolén" });
    expect(await paths()).toEqual([
      "/classified_locations/countries/CL",
      `/classified_locations/states/${RM}`,
    ]);
  });

  it("la región por su nombre en Mercado Libre, con tildes y apóstrofo, o por alias", async () => {
    useMercadoLibre();
    const { catalog, ctx } = setup();

    const byName = await catalog.location(
      { region: "Libertador B. O’Higgins", commune: "la estrella" },
      ctx,
    );
    expect(byName.state).toEqual({ id: OHIGGINS, name: "Libertador B. O'Higgins" });
    expect(byName.city.name).toBe("La Estrella");
  });

  it("una comuna con alias: la ciudad que la contiene y, si el alias lo dice, el barrio", async () => {
    useMercadoLibre();
    const { catalog, ctx, paths } = setup();

    expect(
      await catalog.location({ region: "Metropolitana", commune: "Providencia" }, ctx),
    ).toEqual({
      state: { id: RM, name: "RM (Metropolitana)" },
      city: { id: SANTIAGO, name: "Santiago" },
      neighborhood: { id: "TUxDQlBST3Y", name: "Providencia" },
    });
    expect(
      await catalog.location({ region: "Metropolitana", commune: "Santiago Centro" }, ctx),
    ).toMatchObject({ city: { id: SANTIAGO }, neighborhood: null });
    expect(await paths()).toContain(`/classified_locations/cities/${SANTIAGO}`);
  });

  it.each([
    [{ region: "Atacama", commune: "Copiapó" }, "region"],
    [{ region: "Metropolitana", commune: "Maipú" }, "commune"],
    [{ region: "Metropolitana", commune: "Las Condes" }, "commune"],
  ])("%j: PORTAL_LOCATION_NOT_FOUND (%s)", async (place, level) => {
    useMercadoLibre();
    const { catalog, ctx } = setup();

    const error = await catalog.location(place, ctx).catch((e) => e);
    expect(error).toMatchObject({
      code: "PORTAL_LOCATION_NOT_FOUND",
      retriable: false,
      details: { region: place.region, commune: place.commune, level },
    });
    expect(error.message).toContain(level === "region" ? place.region : place.commune);
  });
});
