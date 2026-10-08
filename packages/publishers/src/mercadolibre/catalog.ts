import {
  type AbortSignalLike,
  AppError,
  isAppError,
  normalizePortalName,
  normalizePortalRegion,
  type PlatformCatalogEntry,
  type PlatformCatalogRepository,
  PORTAL_CATALOG_TTL_MS,
  PORTAL_LOCATION_ALIASES,
  type PortalAttribute,
  type PortalCategory,
  type PortalLocation,
  type PortalLocationAliases,
  type PortalLocationMatch,
  type PortalNamedRef,
  portalAttributesSchema,
  portalCatalogKeys,
  portalCategorySchema,
  portalLocationSchema,
} from "@agentsales/core";
import type { z } from "zod";
import type { MercadoLibreCatalogApi } from "./catalog-api.js";
import { MERCADOLIBRE_COUNTRY_ID, MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID } from "./constants.js";
import { type MercadoLibreTokenContext, withMercadoLibreToken } from "./token.js";

/** El catálogo de Mercado Libre se guarda como de Portal Inmobiliario (la plataforma del enum). */
const PLATFORM = "portal_inmobiliario";

/**
 * Con qué se lee el catálogo: un proveedor de token (lo arma core con `ensureAccessToken`; el
 * catálogo no conoce repositorios de cuentas, ADR-0015 punto 7) y la señal, que corta las llamadas.
 * El catálogo es público: sirve el token de cualquier cuenta conectada.
 */
export type PortalCatalogContext = MercadoLibreTokenContext;

/**
 * Algo que no corta la lectura (solo la clave y códigos):
 * - `PORTAL_CATALOG_STALE`: Mercado Libre no respondió y se usó la copia vencida;
 * - `PORTAL_CATALOG_NOT_SAVED`: se bajó, pero no se pudo guardar (se usa igual).
 */
export type PortalCatalogNote = {
  code: "PORTAL_CATALOG_STALE" | "PORTAL_CATALOG_NOT_SAVED";
  key: string;
  errorCode: string;
};

/** La región y la comuna del aviso, tal como vienen del Excel. */
export type PortalPlace = { region: string; commune: string };

/**
 * El catálogo de Portal con caché (spec F4 §4.4, ADR-0015 punto 5): lo usa el publisher de Portal
 * (`buildPortalItem` en `publish` y `preflight`) y `ml:smoke`. Ningún caso de uso de core lo usa,
 * por eso vive aquí y no en core (seguimiento de F4-T09 en ADR-0015); sus formas sí son de core.
 */
export interface PortalCatalog {
  /**
   * La hoja a la que se llega bajando desde Inmuebles (`MLC1459`) por los nombres de `path` (tipo,
   * operación y subtipo, sin mayúsculas ni tildes): solo baja esas categorías, no el árbol. La
   * última tiene que ser una hoja (`listingAllowed === true`). Si no, `PORTAL_CATEGORY_NOT_FOUND`.
   */
  leafCategory(path: readonly string[], ctx: PortalCatalogContext): Promise<PortalCategory>;
  /** Los atributos de una hoja (obligatorios, condicionales, valores y unidades). */
  attributes(leafId: string, ctx: PortalCatalogContext): Promise<PortalAttribute[]>;
  /**
   * El estado y la ciudad (y el barrio, si un alias lo dice) de una región y una comuna: la región
   * entre los estados de Chile y la comuna entre las ciudades de ese estado, sin mayúsculas ni
   * tildes; lo que no calce por nombre, con los alias de core. Si no, `PORTAL_LOCATION_NOT_FOUND`.
   */
  location(place: PortalPlace, ctx: PortalCatalogContext): Promise<PortalLocationMatch>;
  /**
   * Una categoría por su id, con sus hijas y `settings` (guardada como las de `leafCategory`). La
   * usa `ml:smoke` (F4-T10) para recorrer el árbol y mostrar los nombres reales.
   */
  category(id: string, ctx: PortalCatalogContext): Promise<PortalCategory>;
  /**
   * Un nivel de ubicación por su id: Chile con sus estados, un estado con sus ciudades o una ciudad
   * con sus barrios (guardado como los de `location`). Lo usa `ml:smoke` (F4-T10).
   */
  locationNode(
    level: PortalLocationLevel,
    id: string,
    ctx: PortalCatalogContext,
  ): Promise<PortalLocation>;
}

/** Los niveles de `classified_locations` que se leen (nota §4.7). */
export type PortalLocationLevel = "country" | "state" | "city";

export type PortalCatalogOptions = {
  api: MercadoLibreCatalogApi;
  repository: PlatformCatalogRepository;
  now?: () => Date;
  /** Por defecto, `PORTAL_LOCATION_ALIASES` de core (los tests pasan los suyos). */
  aliases?: PortalLocationAliases;
  onNote?: (note: PortalCatalogNote) => void;
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Si falla la red (o algo pasajero: el límite de llamadas, el candado del token) y hay una copia
 * vencida, se usa.
 * Un corte pedido (`ML_ABORTED`) no: quien cortó no espera un resultado.
 */
const usesStaleCopy = (error: unknown) =>
  isAppError(error) && error.retriable && error.code !== "ML_ABORTED";

type Match = { ref: PortalNamedRef } | { problem: "missing" | "ambiguous" };

/**
 * El alias de una llave, solo si es propia de la tabla: una comuna escrita `constructor` en el
 * Excel no debe encontrar lo que hereda un objeto.
 */
const aliasOf = <V>(table: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** El único hijo cuyo nombre normalizado calza; dos que calzan es ambiguo (no se adivina). */
function findOne(
  refs: readonly PortalNamedRef[],
  wanted: string,
  normalize: (name: string) => string,
): Match {
  const matches = refs.filter((ref) => normalize(ref.name) === wanted);
  if (matches.length === 1 && matches[0] !== undefined) return { ref: matches[0] };
  return { problem: matches.length === 0 ? "missing" : "ambiguous" };
}

const categoryNotFound = (
  path: readonly string[],
  details: {
    name?: string;
    under?: string;
    reason: "missing" | "ambiguous" | "not_leaf" | "empty";
  },
) =>
  new AppError(
    "PORTAL_CATEGORY_NOT_FOUND",
    details.reason === "not_leaf"
      ? `La categoría ${path.join(" > ")} de Mercado Libre no admite publicar: revisa la tabla de categorías`
      : `Mercado Libre no tiene la categoría ${path.join(" > ")}${details.name === undefined ? "" : ` (falta "${details.name}")`}: revisa la tabla de categorías`,
    { details: { path: [...path], ...details } },
  );

const locationNotFound = (
  place: PortalPlace,
  level: "region" | "commune",
  reason: "missing" | "ambiguous",
) =>
  new AppError(
    "PORTAL_LOCATION_NOT_FOUND",
    level === "region"
      ? `Mercado Libre no tiene la región "${place.region}": revisa el nombre o agrega un alias`
      : `Mercado Libre no tiene la comuna "${place.commune}" en ${place.region}: revisa el nombre o agrega un alias`,
    { details: { region: place.region, commune: place.commune, level, reason } },
  );

/**
 * `PortalCatalog` sobre `platform_catalog` (spec F4 §4.4): lee la tabla y, si falta, no calza con
 * su esquema o tiene 7 días o más, consulta a Mercado Libre y la guarda. Si Mercado Libre falla por
 * algo pasajero y hay una copia vencida, la usa y avisa (`onNote`); sin copia, el error sube. Un
 * token rechazado (401) se pide de nuevo una vez (`rejectedToken`); un segundo 401 sube marcado
 * (`details.reason: "rejected_after_refresh"`), que ya no cuenta como "refrescar y repetir".
 */
export function createPortalCatalog(options: PortalCatalogOptions): PortalCatalog {
  const now = options.now ?? (() => new Date());
  const aliases = options.aliases ?? PORTAL_LOCATION_ALIASES;
  const note = (code: PortalCatalogNote["code"], key: string, error: unknown) =>
    options.onNote?.({ code, key, errorCode: codeOf(error) });

  async function cached<T>(
    key: string,
    schema: z.ZodType<T>,
    ctx: PortalCatalogContext,
    fetch: (token: string, signal: AbortSignalLike | undefined) => Promise<T>,
  ): Promise<T> {
    const entry = await options.repository.get(PLATFORM, key);
    const stored = entry === null ? null : schema.safeParse(entry.data);
    const copy = stored?.success === true ? stored.data : null;
    // Una fecha futura (reloj descuadrado) cuenta como vencida: si no, nunca se volvería a bajar.
    const age = entry === null ? null : now().getTime() - entry.fetchedAt.getTime();
    if (copy !== null && age !== null && age >= 0 && age < PORTAL_CATALOG_TTL_MS) return copy;
    // Dos lecturas a la vez de un nodo vencido lo bajan dos veces: es un duplicado benigno (la
    // segunda reemplaza a la primera con lo mismo).
    let fresh: T;
    try {
      fresh = await withMercadoLibreToken(ctx, fetch);
    } catch (error) {
      if (copy !== null && usesStaleCopy(error)) {
        note("PORTAL_CATALOG_STALE", key, error);
        return copy;
      }
      throw error;
    }
    try {
      await options.repository.put({
        platform: PLATFORM,
        key,
        // `T` sale siempre de los esquemas de core del catálogo, que son JSON.
        data: fresh as PlatformCatalogEntry["data"],
        fetchedAt: now(),
      });
    } catch (error) {
      note("PORTAL_CATALOG_NOT_SAVED", key, error);
    }
    return fresh;
  }

  const category = (id: string, ctx: PortalCatalogContext) =>
    cached(portalCatalogKeys.category(id), portalCategorySchema, ctx, (token, signal) =>
      options.api.category(token, id, { signal }),
    );

  const location = (
    level: PortalLocationLevel,
    id: string,
    ctx: PortalCatalogContext,
  ): Promise<PortalLocation> =>
    cached(portalCatalogKeys.location(id), portalLocationSchema, ctx, (token, signal) =>
      options.api[level](token, id, { signal }),
    );

  return {
    category,
    locationNode: location,

    async leafCategory(path, ctx) {
      if (path.length === 0) throw categoryNotFound(path, { reason: "empty" });
      let node = await category(MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID, ctx);
      for (const name of path) {
        const match = findOne(
          node.childrenCategories,
          normalizePortalName(name),
          normalizePortalName,
        );
        if ("problem" in match) {
          throw categoryNotFound(path, { name, under: node.name, reason: match.problem });
        }
        node = await category(match.ref.id, ctx);
      }
      if (node.settings.listingAllowed !== true)
        throw categoryNotFound(path, { reason: "not_leaf" });
      return node;
    },

    attributes(leafId, ctx) {
      return cached(
        portalCatalogKeys.attributes(leafId),
        portalAttributesSchema,
        ctx,
        (token, signal) => options.api.attributes(token, leafId, { signal }),
      );
    },

    async location(place, ctx) {
      const country = await location("country", MERCADOLIBRE_COUNTRY_ID, ctx);
      const region = normalizePortalRegion(place.region);
      let stateMatch = findOne(country.children, region, normalizePortalRegion);
      const regionAlias = aliasOf(aliases.regions, region);
      if (
        "problem" in stateMatch &&
        stateMatch.problem === "missing" &&
        regionAlias !== undefined
      ) {
        stateMatch = findOne(
          country.children,
          normalizePortalRegion(regionAlias),
          normalizePortalRegion,
        );
      }
      if ("problem" in stateMatch) throw locationNotFound(place, "region", stateMatch.problem);
      const state = await location("state", stateMatch.ref.id, ctx);
      const stateRef = { id: state.id, name: state.name };

      const commune = normalizePortalName(place.commune);
      const cityMatch = findOne(state.children, commune, normalizePortalName);
      if ("ref" in cityMatch) return { state: stateRef, city: cityMatch.ref, neighborhood: null };
      const alias = aliasOf(aliases.communes, commune);
      if (cityMatch.problem === "ambiguous" || alias === undefined) {
        throw locationNotFound(place, "commune", cityMatch.problem);
      }
      const aliasCity = findOne(
        state.children,
        normalizePortalName(alias.city),
        normalizePortalName,
      );
      if ("problem" in aliasCity) throw locationNotFound(place, "commune", aliasCity.problem);
      if (alias.neighborhood === undefined) {
        return { state: stateRef, city: aliasCity.ref, neighborhood: null };
      }
      const city = await location("city", aliasCity.ref.id, ctx);
      const neighborhood = findOne(
        city.children,
        normalizePortalName(alias.neighborhood),
        normalizePortalName,
      );
      if ("problem" in neighborhood) throw locationNotFound(place, "commune", neighborhood.problem);
      return { state: stateRef, city: aliasCity.ref, neighborhood: neighborhood.ref };
    },
  };
}
