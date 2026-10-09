import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

// Mercado Libre simulado con msw (F4-T23): el catálogo de Inmuebles para un departamento en venta,
// las ubicaciones de la región inventada del escenario de core y `POST /items/validate`. Nunca sale
// a internet (`onUnhandledFrame: "error"`). Las escrituras responden como Mercado Libre, para que
// una llamada no se note en la salida: solo la detecta `writes`.

const API = "https://api.mercadolibre.com";

/** Lo que recibió el Mercado Libre simulado. */
export type Recorded = { method: string; path: string; json: unknown };

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

const CATEGORIES: Record<string, unknown> = {
  MLC1459: category("MLC1459", "Inmuebles", [["MLC1472", "Departamentos"]]),
  MLC1472: category("MLC1472", "Departamentos", [["MLC1473", "Venta"]]),
  MLC1473: category("MLC1473", "Venta", [["MLC1480", "Propiedades Usadas"]]),
  MLC1480: category("MLC1480", "Propiedades Usadas", [], {
    listing_allowed: true,
    max_title_length: 60,
    max_pictures_per_item: 30,
    currencies: ["CLP", "CLF"],
  }),
};

const area = (id: string, name: string) => ({
  id,
  name,
  tags: { required: true },
  value_type: "number_unit",
  allowed_units: [{ id: "m²", name: "m²" }],
  default_unit: "m²",
});

const ATTRIBUTES = [
  { id: "BEDROOMS", name: "Dormitorios", tags: { required: true }, value_type: "number" },
  { id: "FULL_BATHROOMS", name: "Baños", tags: { required: true }, value_type: "number" },
  area("COVERED_AREA", "Superficie útil"),
  area("TOTAL_AREA", "Superficie total"),
  { id: "PARKING_LOTS", name: "Estacionamientos", tags: {}, value_type: "number" },
  { id: "WAREHOUSES", name: "Bodegas", tags: {}, value_type: "number" },
  {
    id: "MAINTENANCE_FEE",
    name: "Gastos comunes",
    tags: {},
    value_type: "number_unit",
    allowed_units: [{ id: "CLP", name: "CLP" }],
  },
  {
    id: "FURNISHED",
    name: "Amoblado",
    tags: {},
    value_type: "boolean",
    values: [
      { id: "242085", name: "Sí" },
      { id: "242084", name: "No" },
    ],
  },
  {
    id: "PROPERTY_TYPE",
    name: "Inmueble",
    tags: { required: true, read_only: true, fixed: true },
    value_type: "list",
  },
];

const STATE = "TUxDUElOVg";
const CITY = "TUxDQ05VTmE";
const COUNTRY = { id: "CL", name: "Chile", states: [{ id: STATE, name: "Región Inventada" }] };
const STATES: Record<string, object> = {
  [STATE]: { id: STATE, name: "Región Inventada", cities: [{ id: CITY, name: "Ñuñoa" }] },
};
const CITIES: Record<string, object> = {
  [CITY]: { id: CITY, name: "Ñuñoa", neighborhoods: [] },
};

export type ValidateReply = "accept" | "no_quota" | "reject" | "quota_blocked";

/**
 * El servidor msw con su registro. Llamar una vez por archivo de pruebas (registra `beforeAll`,
 * `afterEach` y `afterAll`).
 */
export function useMercadoLibreSim() {
  const requests: Recorded[] = [];
  const pending = new Set<Promise<void>>();
  const server = setupServer();
  server.events.on("request:start", ({ request }) => {
    const recording = (async () => {
      const text = request.method === "GET" ? "" : await request.clone().text();
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
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
    return [...requests];
  };

  /** Mercado Libre con `validate` respondiendo como se pida. */
  const use = (validate: ValidateReply = "accept") =>
    server.use(
      http.get(`${API}/categories/:id/attributes`, () => HttpResponse.json(ATTRIBUTES)),
      http.get(`${API}/categories/:id`, ({ params }) => {
        const found = CATEGORIES[String(params.id)];
        return found === undefined
          ? HttpResponse.json({ message: "not found" }, { status: 404 })
          : HttpResponse.json(found);
      }),
      http.get(`${API}/classified_locations/countries/CL`, () => HttpResponse.json(COUNTRY)),
      http.get(`${API}/classified_locations/states/:id`, ({ params }) =>
        HttpResponse.json(STATES[String(params.id)] ?? { message: "not found" }),
      ),
      http.get(`${API}/classified_locations/cities/:id`, ({ params }) =>
        HttpResponse.json(CITIES[String(params.id)] ?? { message: "not found" }),
      ),
      http.post(`${API}/items/validate`, () => {
        if (validate === "accept") return new HttpResponse(null, { status: 204 });
        if (validate === "no_quota") return new HttpResponse(null, { status: 402 });
        if (validate === "quota_blocked") {
          return HttpResponse.json(
            {
              message: "Sin cupo",
              error: "validation_error",
              status: 402,
              cause: [{ code: "item.listing_type_id.invalid", cause_id: 1100, type: "error" }],
            },
            { status: 402 },
          );
        }
        return HttpResponse.json(
          {
            message: "Validation error",
            error: "validation_error",
            status: 400,
            cause: [{ code: "item.attributes.missing_required", cause_id: 147, type: "error" }],
          },
          { status: 400 },
        );
      }),
      // Lo que nunca se debe llamar: responde como Mercado Libre.
      http.post(`${API}/items`, () => HttpResponse.json({ id: "MLC1", status: "active" })),
      http.put(`${API}/items/:id`, () => HttpResponse.json({ id: "MLC1", status: "paused" })),
      http.post(`${API}/items/:id/description`, () => HttpResponse.json({})),
      http.put(`${API}/items/:id/address_line_by_reference`, () => HttpResponse.json({})),
      http.post(`${API}/pictures/items/upload`, () => HttpResponse.json({ id: "123-MLC" })),
    );

  /** Lo que escribe en Mercado Libre: solo puede haber `POST /items/validate`. */
  const writes = async () =>
    (await recorded()).filter(
      (request) => request.method !== "GET" && request.path !== "/items/validate",
    );

  return { server, recorded, use, writes };
}
