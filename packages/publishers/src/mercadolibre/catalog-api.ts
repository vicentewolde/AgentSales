import { z } from "zod";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { MERCADOLIBRE_ERRORS } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
  parseBody,
} from "./http.js";

/** Una categoría de Mercado Libre (`MLC1459`). Va en la ruta de la llamada. */
const CATEGORY_ID = /^[A-Z]{3}\d{1,20}$/;
/**
 * Una ubicación de `classified_locations`: el país (`CL`) o un id en base64 (`TUxDUE9IUzFjODg`,
 * nota §4.7). Va en la ruta de la llamada.
 */
const LOCATION_ID = /^[A-Za-z0-9_=-]{1,64}$/;

/** Un nodo con nombre (una categoría hija, un estado, una ciudad, un barrio). */
export type MercadoLibreNamedRef = { id: string; name: string };

/**
 * Una categoría (nota §4.6): sus hijas y los `settings` que usa el mapeo (spec F4 §4.5). Es una
 * hoja si no tiene hijas. Lo que no venga o no se entienda queda en `null` (o `[]`): el mapeo lo
 * trata como "sin límite conocido", nunca lo inventa.
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
    /** Monedas permitidas (`CLP`, `CLF`): fuera de ellas, `PORTAL_CURRENCY_NOT_ALLOWED`. */
    currencies: string[];
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
/** Una lista de nodos con nombre: los que no se entiendan se descartan, no rompen la lectura. */
const namedRefs = z
  .array(z.unknown())
  .nullish()
  .catch(null)
  .transform((value) =>
    (value ?? []).flatMap((entry) => {
      const parsed = namedRef.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const textList = z
  .array(z.string())
  .nullish()
  .catch(null)
  .transform((value) => value ?? []);

const categorySchema = z
  .object({
    id: z.string().regex(CATEGORY_ID),
    name: z.string(),
    children_categories: namedRefs,
    settings: z
      .object({
        listing_allowed: z.boolean().nullish().catch(null),
        max_title_length: positiveOrNull,
        max_pictures_per_item: positiveOrNull,
        max_description_length: positiveOrNull,
        currencies: textList,
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
        currencies: category.settings?.currencies ?? [],
        minimumPrice: category.settings?.minimum_price ?? null,
        maximumPrice: category.settings?.maximum_price ?? null,
      },
    }),
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
    tags: z.record(z.string(), z.unknown()).nullish().catch(null),
    values: namedRefs,
    allowed_units: namedRefs,
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
      required: attribute.tags?.required === true,
      conditionalRequired: attribute.tags?.conditional_required === true,
      values: attribute.values,
      allowedUnits: attribute.allowed_units,
      defaultUnit: attribute.default_unit,
      valueMaxLength: attribute.value_max_length,
    }),
  );

/** Los atributos: uno que no se entienda se descarta (Mercado Libre agrega formas nuevas). */
const attributesSchema = z.array(z.unknown()).transform((entries) =>
  entries.flatMap((entry) => {
    const parsed = attributeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }),
);

/** Un nivel de ubicación; la lista del nivel de abajo se llama distinto en cada uno (nota §4.7). */
const locationBase = { id: z.string().min(1), name: z.string() };
const toLocation = (id: string, name: string, children: MercadoLibreNamedRef[]) => ({
  id,
  name,
  children,
});
const countrySchema = z
  .object({ ...locationBase, states: namedRefs })
  .transform(
    (location): MercadoLibreLocation => toLocation(location.id, location.name, location.states),
  );
const stateSchema = z
  .object({ ...locationBase, cities: namedRefs })
  .transform(
    (location): MercadoLibreLocation => toLocation(location.id, location.name, location.cities),
  );
const citySchema = z
  .object({ ...locationBase, neighborhoods: namedRefs })
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
    if (!LOCATION_ID.test(locationId)) throw MERCADOLIBRE_ERRORS.invalidId("location");
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
