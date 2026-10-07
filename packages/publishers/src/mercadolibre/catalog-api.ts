import { z } from "zod";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { MERCADOLIBRE_ERRORS } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
  parseBody,
} from "./http.js";

/** Una categoría de Mercado Libre Chile (`MLC1459`; el sitio es fijo). Va en la ruta de la llamada. */
const CATEGORY_ID = /^MLC\d{1,20}$/;
/** Un país de `classified_locations` (`CL`). */
const COUNTRY_ID = /^[A-Z]{2}$/;
/**
 * Una ubicación de `classified_locations`: el país (`CL`) o un id en base64 (`TUxDUE9IUzFjODg`,
 * nota §4.7). Va en la ruta de la llamada.
 */
const LOCATION_ID = /^[A-Za-z0-9_=-]{1,64}$/;

/** Un nodo con nombre (una categoría hija, un estado, una ciudad, un barrio). */
export type MercadoLibreNamedRef = { id: string; name: string };

/**
 * Una categoría (nota §4.6): sus hijas y los `settings` que usa el mapeo (spec F4 §4.5). Una hoja
 * es la que tiene `listingAllowed === true` (y no tiene hijas): no basta con que no tenga hijas.
 * Un `setting` que no venga o no se entienda queda en `null`: el mapeo lo trata como "sin límite
 * conocido", nunca lo inventa. Las hijas, en cambio, tienen que entenderse todas.
 */
export type MercadoLibreCategory = {
  id: string;
  name: string;
  childrenCategories: MercadoLibreNamedRef[];
  settings: {
    /** `listing_allowed`: si se puede publicar en ella (solo las hojas). */
    listingAllowed: boolean | null;
    maxTitleLength: number | null;
    maxPicturesPerItem: number | null;
    maxDescriptionLength: number | null;
    /**
     * Monedas permitidas (`CLP`, `CLF`): fuera de ellas, `PORTAL_CURRENCY_NOT_ALLOWED`. `null` si
     * no vinieron (sin dato), distinto de `[]` (ninguna).
     */
    currencies: string[] | null;
    minimumPrice: number | null;
    maximumPrice: number | null;
  };
};

/** Un atributo de una hoja (`GET /categories/{hoja}/attributes`, nota §4.6). */
export type MercadoLibreAttribute = {
  id: string;
  name: string;
  /** `number`, `number_unit`, `list`, `boolean`, `string`, … */
  valueType: string | null;
  /** `tags.required`. */
  required: boolean;
  /** `tags.conditional_required` (error 7810 si falta cuando corresponde). */
  conditionalRequired: boolean;
  /**
   * Los tags en `true` (`required`, `read_only`, `fixed`, `hidden`, …): el mapeo (T11) no exige ni
   * envía los que Mercado Libre completa solo (`PROPERTY_TYPE`, `OPERATION`, nota §4.1).
   */
  tags: string[];
  /** Valores de una lista (Sí y No con su `value_id`, por ejemplo). */
  values: MercadoLibreNamedRef[];
  /** Unidades de un `number_unit` (`m²`). */
  allowedUnits: MercadoLibreNamedRef[];
  defaultUnit: string | null;
  valueMaxLength: number | null;
};

/** Un nivel de `classified_locations` con los del nivel de abajo (nota §4.7). */
export type MercadoLibreLocation = {
  id: string;
  name: string;
  /** Los estados de un país, las ciudades de un estado o los barrios de una ciudad. */
  children: MercadoLibreNamedRef[];
};

/**
 * Lectura del catálogo de Mercado Libre (spec F4 §4.4): categorías, atributos de una hoja y
 * ubicaciones de clasificados. Todo con el token (la API lo exige también para leer categorías).
 * Solo lee: lo usan el catálogo con caché (T09), `preflight` y `ml:smoke` (ADR-0016). Errores: los
 * `ML_*` de `mercadoLibreRequest`, más `ML_ID_INVALID` si un id no tiene la forma de Mercado Libre
 * (no se llama).
 */
export interface MercadoLibreCatalogApi {
  /** `GET /categories/{id}`. */
  category(
    accessToken: string,
    categoryId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreCategory>;
  /** `GET /categories/{id}/attributes`. */
  attributes(
    accessToken: string,
    categoryId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreAttribute[]>;
  /** `GET /classified_locations/countries/CL`: Chile y sus estados (regiones). */
  country(
    accessToken: string,
    countryId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreLocation>;
  /** `GET /classified_locations/states/{id}`: un estado y sus ciudades. */
  state(
    accessToken: string,
    stateId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreLocation>;
  /** `GET /classified_locations/cities/{id}`: una ciudad y sus barrios. */
  city(
    accessToken: string,
    cityId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreLocation>;
}

/** Un número positivo o `null` (lo que no se entienda no se inventa). */
const positiveOrNull = z
  .number()
  .positive()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const namedRef = z.object({
  id: z.union([z.string().min(1), z.number().int()]).transform(String),
  name: z.string(),
});
/**
 * Una lista de nodos con nombre que **tiene** que venir (las hijas de una categoría, los estados de
 * un país, las ciudades de un estado): si falta o una entrada no se entiende, la respuesta entera es
 * inesperada. Descartar en silencio haría parecer final una categoría o dejaría a una región sin
 * comunas.
 */
const requiredRefs = z.array(namedRef);
/** Igual, pero puede faltar (`[]`): los barrios de una ciudad, los valores de un atributo. */
const optionalRefs = requiredRefs.nullish().transform((value) => value ?? []);

/** Las monedas: `null` si no vinieron o no son una lista; de la lista, solo los textos. */
const currencies = z
  .unknown()
  .transform((value) =>
    Array.isArray(value)
      ? value.filter((currency): currency is string => typeof currency === "string")
      : null,
  );

const categorySchema = z
  .object({
    id: z.string().regex(CATEGORY_ID),
    name: z.string(),
    children_categories: requiredRefs,
    settings: z
      .object({
        listing_allowed: z.boolean().nullish().catch(null),
        max_title_length: positiveOrNull,
        max_pictures_per_item: positiveOrNull,
        max_description_length: positiveOrNull,
        currencies,
        minimum_price: positiveOrNull,
        maximum_price: positiveOrNull,
      })
      .nullish()
      .catch(null),
  })
  .transform(
    (category): MercadoLibreCategory => ({
      id: category.id,
      name: category.name,
      childrenCategories: category.children_categories,
      settings: {
        listingAllowed: category.settings?.listing_allowed ?? null,
        maxTitleLength: category.settings?.max_title_length ?? null,
        maxPicturesPerItem: category.settings?.max_pictures_per_item ?? null,
        maxDescriptionLength: category.settings?.max_description_length ?? null,
        currencies: category.settings?.currencies ?? null,
        minimumPrice: category.settings?.minimum_price ?? null,
        maximumPrice: category.settings?.maximum_price ?? null,
      },
    }),
  );

/** Un tag de Mercado Libre (`required`, `read_only`, `fixed`, `hidden`, …). */
const TAG_NAME = /^[a-z_]{1,50}$/;
/**
 * Los tags de un atributo: un objeto de booleanos. Otra forma (una lista, un texto, un `"true"`)
 * es inesperada: leerla como "sin tags" dejaría un obligatorio como opcional sin avisar.
 */
const tagsSchema = z
  .record(z.string(), z.boolean())
  .nullish()
  .transform((tags) =>
    Object.entries(tags ?? {})
      .filter(([name, on]) => on && TAG_NAME.test(name))
      .map(([name]) => name),
  );

const attributeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    value_type: z
      .string()
      .nullish()
      .catch(null)
      .transform((value) => value ?? null),
    tags: tagsSchema,
    values: optionalRefs,
    allowed_units: optionalRefs,
    default_unit: z
      .string()
      .nullish()
      .catch(null)
      .transform((value) => value ?? null),
    value_max_length: positiveOrNull,
  })
  .transform(
    (attribute): MercadoLibreAttribute => ({
      id: attribute.id,
      name: attribute.name,
      valueType: attribute.value_type,
      required: attribute.tags.includes("required"),
      conditionalRequired: attribute.tags.includes("conditional_required"),
      tags: attribute.tags,
      values: attribute.values,
      allowedUnits: attribute.allowed_units,
      defaultUnit: attribute.default_unit,
      valueMaxLength: attribute.value_max_length,
    }),
  );

/**
 * Los atributos de una hoja: todos deben entenderse, y la lista no viene vacía (una hoja de
 * inmuebles siempre los tiene). Uno que no se entienda podría ser un obligatorio perdido.
 */
const attributesSchema = z.array(attributeSchema).min(1);

/** Un nivel de ubicación; la lista del nivel de abajo se llama distinto en cada uno (nota §4.7). */
const locationBase = { id: z.string().min(1), name: z.string() };
const toLocation = (id: string, name: string, children: MercadoLibreNamedRef[]) => ({
  id,
  name,
  children,
});
const countrySchema = z
  .object({ ...locationBase, states: requiredRefs })
  .transform(
    (location): MercadoLibreLocation => toLocation(location.id, location.name, location.states),
  );
const stateSchema = z
  .object({ ...locationBase, cities: requiredRefs })
  .transform(
    (location): MercadoLibreLocation => toLocation(location.id, location.name, location.cities),
  );
/** Una ciudad puede no tener barrios (el ejemplo chileno de la doc los trae vacíos). */
const citySchema = z
  .object({ ...locationBase, neighborhoods: optionalRefs })
  .transform(
    (location): MercadoLibreLocation =>
      toLocation(location.id, location.name, location.neighborhoods),
  );

export function createMercadoLibreCatalogApi(
  options: MercadoLibreHttpOptions = {},
): MercadoLibreCatalogApi {
  const origin = options.origin ?? MERCADOLIBRE_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? MERCADOLIBRE_REQUEST_TIMEOUT_MS;

  const get = (
    name: string,
    path: string,
    accessToken: string,
    { signal }: MercadoLibreCallOptions = {},
  ) =>
    mercadoLibreRequest(
      name,
      new URL(path, origin),
      { method: "GET", accessToken },
      { signal, timeoutMs },
    );

  const categoryPath = (categoryId: string, suffix = "") => {
    if (!CATEGORY_ID.test(categoryId)) throw MERCADOLIBRE_ERRORS.invalidId("category");
    return `/categories/${categoryId}${suffix}`;
  };
  const locationPath = (level: "countries" | "states" | "cities", locationId: string) => {
    const pattern = level === "countries" ? COUNTRY_ID : LOCATION_ID;
    if (!pattern.test(locationId)) throw MERCADOLIBRE_ERRORS.invalidId("location");
    return `/classified_locations/${level}/${locationId}`;
  };
  /** La respuesta debe ser del id pedido: otra cosa guardaría datos ajenos en el catálogo. */
  const same = <T extends { id: string }>(name: string, requested: string, value: T): T => {
    if (value.id !== requested) throw MERCADOLIBRE_ERRORS.unexpectedResponse(name);
    return value;
  };

  return {
    async category(accessToken, categoryId, callOptions) {
      const body = await get("category", categoryPath(categoryId), accessToken, callOptions);
      return same("category", categoryId, parseBody("category", categorySchema, body));
    },

    async attributes(accessToken, categoryId, callOptions) {
      const path = categoryPath(categoryId, "/attributes");
      const body = await get("attributes", path, accessToken, callOptions);
      return parseBody("attributes", attributesSchema, body);
    },

    async country(accessToken, countryId, callOptions) {
      const body = await get(
        "country",
        locationPath("countries", countryId),
        accessToken,
        callOptions,
      );
      return same("country", countryId, parseBody("country", countrySchema, body));
    },

    async state(accessToken, stateId, callOptions) {
      const body = await get("state", locationPath("states", stateId), accessToken, callOptions);
      return same("state", stateId, parseBody("state", stateSchema, body));
    },

    async city(accessToken, cityId, callOptions) {
      const body = await get("city", locationPath("cities", cityId), accessToken, callOptions);
      return same("city", cityId, parseBody("city", citySchema, body));
    },
  };
}
