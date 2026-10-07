import { z } from "zod";

/**
 * El catálogo de Portal Inmobiliario (spec F4 §4.4, ADR-0015 punto 5): las formas normalizadas que
 * devuelve el cliente de Mercado Libre (`catalog-api.ts`, F4-T05) y que se guardan en
 * `platform_catalog.data`. Son también los esquemas para leer `data` de vuelta: una entrada que ya
 * no calce se trata como ausente y se vuelve a bajar (sumar un campo no obliga a migrar).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Una entrada del catálogo vale 7 días desde que se bajó (`fetched_at`); después se pide de nuevo. */
export const PORTAL_CATALOG_TTL_MS = 7 * DAY_MS;

/** Inmuebles en Mercado Libre Chile: la raíz desde la que se baja por nombres (nota §4.6). */
export const PORTAL_ROOT_CATEGORY_ID = "MLC1459";

/** Chile en `classified_locations` (nota §4.7): trae los estados (regiones). */
export const PORTAL_COUNTRY_ID = "CL";

/** Las claves de `platform_catalog` (forma `tipo:id`). */
export const portalCatalogKeys = {
  category: (id: string) => `category:${id}`,
  attributes: (leafId: string) => `attributes:${leafId}`,
  location: (id: string) => `location:${id}`,
} as const;

/** Un nodo con nombre: una categoría hija, un estado, una ciudad o un barrio. */
export const portalNamedRefSchema = z.object({ id: z.string().min(1), name: z.string() });
export type PortalNamedRef = z.infer<typeof portalNamedRefSchema>;

/**
 * Una categoría con sus hijas y los `settings` que usa el mapeo (spec F4 §4.5). Una hoja es la que
 * tiene `listingAllowed === true`, no solo la que no tiene hijas. Lo que Mercado Libre no informó
 * queda en `null` (sin límite conocido, nunca inventado); `currencies: null` es "sin dato", distinto
 * de `[]` ("ninguna").
 */
export const portalCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  childrenCategories: z.array(portalNamedRefSchema),
  settings: z.object({
    listingAllowed: z.boolean().nullable(),
    maxTitleLength: z.number().positive().nullable(),
    maxPicturesPerItem: z.number().positive().nullable(),
    maxDescriptionLength: z.number().positive().nullable(),
    currencies: z.array(z.string()).nullable(),
    minimumPrice: z.number().positive().nullable(),
    maximumPrice: z.number().positive().nullable(),
  }),
});
export type PortalCategory = z.infer<typeof portalCategorySchema>;

/**
 * Un atributo de una hoja (nota §4.6): obligatorio (`required`), obligatorio condicional y sus
 * `tags` en `true` (`read_only`, `fixed`, `hidden`: los que completa la categoría no se exigen ni
 * se envían, T11), con sus valores de lista y unidades.
 */
export const portalAttributeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** `number`, `number_unit`, `list`, `boolean`, `string`, … */
  valueType: z.string().nullable(),
  required: z.boolean(),
  conditionalRequired: z.boolean(),
  tags: z.array(z.string()),
  values: z.array(portalNamedRefSchema),
  allowedUnits: z.array(portalNamedRefSchema),
  defaultUnit: z.string().nullable(),
  valueMaxLength: z.number().positive().nullable(),
});
export type PortalAttribute = z.infer<typeof portalAttributeSchema>;

/** Los atributos de una hoja: nunca vacíos (una hoja de inmuebles siempre los tiene). */
export const portalAttributesSchema = z.array(portalAttributeSchema).min(1);

/** Un nivel de `classified_locations` con los del nivel de abajo (estados, ciudades o barrios). */
export const portalLocationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  children: z.array(portalNamedRefSchema),
});
export type PortalLocation = z.infer<typeof portalLocationSchema>;

/** La ubicación de un aviso en Mercado Libre: mínimo la ciudad (nota §4.7). */
export type PortalLocationMatch = {
  state: PortalNamedRef;
  city: PortalNamedRef;
  neighborhood: PortalNamedRef | null;
};

/**
 * Un nombre para comparar (categorías, regiones, comunas): sin tildes ni mayúsculas, sin apóstrofos
 * (`O'Higgins` = `OHiggins`) y con la puntuación como espacio (`B. O'Higgins` = `b ohiggins`).
 */
export function normalizePortalName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Una región para comparar: además, sin el "Región de", "Región del" o "Región" del comienzo. */
export function normalizePortalRegion(name: string): string {
  return normalizePortalName(name).replace(/^region( del?)? /, "");
}

/**
 * Lo que no calza por nombre entre el aviso y Mercado Libre (spec F4 §4.4). Las llaves y los valores
 * se comparan normalizados (`normalizePortalRegion` y `normalizePortalName`).
 * - `regions`: la región del aviso → el nombre del estado en Mercado Libre.
 * - `communes`: la comuna del aviso → la ciudad de Mercado Libre que la contiene y, si la comuna es
 *   un barrio de esa ciudad, el barrio (en Chile una "ciudad" puede agrupar comunas, nota §4.7).
 */
export type PortalLocationAliases = {
  regions: Readonly<Record<string, string>>;
  communes: Readonly<Record<string, { city: string; neighborhood?: string }>>;
};

/**
 * Las equivalencias conocidas. Solo lo verificado en la doc (el estado `Libertador B. O'Higgins`,
 * nota §4.7); `ml:smoke` (T10) imprime los nombres reales de los estados y ciudades y se completan
 * aquí antes del mapeo (T11).
 */
export const PORTAL_LOCATION_ALIASES: PortalLocationAliases = {
  regions: {
    ohiggins: "Libertador B. O'Higgins",
    "libertador general bernardo ohiggins": "Libertador B. O'Higgins",
    "libertador bernardo ohiggins": "Libertador B. O'Higgins",
  },
  communes: {},
};
