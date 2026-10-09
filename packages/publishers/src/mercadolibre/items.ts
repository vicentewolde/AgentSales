import { isAppError, type PortalSellerContact } from "@agentsales/core";
import { z } from "zod";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { MAX_CAUSES, MERCADOLIBRE_ERRORS, type MercadoLibreCause, parseCauses } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
  parseBody,
  type RequestBody,
} from "./http.js";

/** Un ítem de Mercado Libre: el sitio y dígitos (`MLC1234567890`). Va en la ruta de la llamada. */
const ITEM_ID = /^[A-Z]{3}\d{1,20}$/;
/** Un usuario de Mercado Libre: solo dígitos. Va en la ruta de la llamada. */
const USER_ID = /^\d{1,20}$/;

/** Los únicos estados que el cliente escribe (nota §4.4): nunca `deleted` ni otro. */
export const MERCADOLIBRE_WRITABLE_STATUSES = ["paused", "active", "closed"] as const;
export type MercadoLibreWritableStatus = (typeof MERCADOLIBRE_WRITABLE_STATUSES)[number];

/**
 * El cuerpo de `POST /items` (nota §4.1): lo arma `buildPortalItem` (T11). El cliente no lo
 * interpreta: lo envía tal cual.
 */
export type MercadoLibreItemBody = Readonly<Record<string, unknown>>;

/** Lo que el sistema usa de un ítem (nota §4.5); las fechas, tal como vienen (ISO con zona). */
export type MercadoLibreItem = {
  id: string;
  permalink: string | null;
  /** `active`, `paused`, `closed`, `under_review`, `not_yet_active`, … */
  status: string;
  /** `picture_download_pending`, `expired`, … */
  subStatus: string[];
  startTime: string | null;
  stopTime: string | null;
  expirationTime: string | null;
  lastUpdated: string | null;
  tags: string[];
  /** `portalinmobiliario` cuando salió también en Portal (`CMG_SITE`, nota §4.1). */
  listingSource: string | null;
  /** El id de la publicación que se guardó al crear (spec F4 §4.8). */
  sellerCustomField: string | null;
  /**
   * Advertencias que no bloquean (`warnings` o `cause[]` con `type: warning` en una respuesta que
   * salió bien, INFERENCIA de la nota §7): van a la bitácora.
   */
  warnings: MercadoLibreCause[];
};

/** Los estados por los que se puede filtrar la búsqueda de ítems del vendedor (nota §4.5). */
export const MERCADOLIBRE_SEARCH_STATUSES = [
  "pending",
  "not_yet_active",
  "programmed",
  "active",
  "paused",
  "closed",
] as const;
export type MercadoLibreSearchStatus = (typeof MERCADOLIBRE_SEARCH_STATUSES)[number];

/** Un valor de un filtro de la búsqueda (`active` en `status`), con cuántos ítems trae. */
export type MercadoLibreSearchFilterValue = {
  id: string;
  name: string | null;
  results: number | null;
};
/** Un filtro de la búsqueda (`status`, `listing_type`, …) con sus valores. */
export type MercadoLibreSearchFilter = { id: string; values: MercadoLibreSearchFilterValue[] };

/**
 * Una búsqueda de ítems del vendedor (`GET /users/{id}/items/search`, nota §4.5): los ids, el total
 * y los filtros. Con `include_filters=true`, `filters` dice lo que la búsqueda aplicó (también por
 * defecto) y `availableFilters`, por qué más se puede filtrar y cuántos ítems hay en cada valor.
 * La forma de los filtros: NO VERIFICADO (la lee `ml:smoke`, F4-T10); lo que no se entienda queda
 * fuera, sin inventar.
 */
export type MercadoLibreItemSearch = {
  total: number | null;
  results: string[];
  filters: MercadoLibreSearchFilter[];
  availableFilters: MercadoLibreSearchFilter[];
};

/**
 * La última moderación de un ítem (`GET /moderations/last_moderation/{id}-ITM`, doc "Moderaciones
 * con pausado", leída el 2026-10-08): solo su `name` (`ABANDONED_ITEM_REX_DEN`, …), el filtro que
 * la generó. Sus textos (`REASON`, `REMEDY`) y la evidencia no se guardan: son de Mercado Libre y
 * la evidencia puede traer datos del aviso (el precio). `name: null` si no vino o no tiene forma de
 * identificador.
 */
export type MercadoLibreModeration = { name: string | null };

export type MercadoLibreItemSearchQuery = {
  status?: MercadoLibreSearchStatus;
  includeFilters?: boolean;
};

/**
 * Ítems de Mercado Libre (spec F4 §4.8, nota §4): crear, leer, cambiar el estado, cargar la
 * descripción, ocultar la dirección, leer la última moderación y buscar por `seller_custom_field`.
 * **No borra**: no hay método de borrado ni la marca de borrado del ítem, y el estado solo puede
 * ser `paused`, `active` o `closed` (cerrar basta, spec F4 §3). Errores: los `ML_*` de
 * `mercadoLibreRequest`, más `ML_ID_INVALID` si un id que va en la ruta no tiene la forma de
 * Mercado Libre (no se llama).
 */
export interface MercadoLibreItems {
  /**
   * `POST /items`. Si no termina (red, tope, señal, respuesta inesperada), el ítem **pudo** crearse:
   * quien llama no repite el pedido a ciegas, sino que busca con `findBySellerCustomField`.
   */
  create(
    accessToken: string,
    body: MercadoLibreItemBody,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreItem>;
  /** `GET /items/{id}`. */
  get(
    accessToken: string,
    itemId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreItem>;
  /**
   * `PUT /items/{id}` con el estado y el `seller_contact` completo, que Mercado Libre exige en cada
   * escritura desde el 01/10/2026 (nota §4.2).
   */
  setStatus(
    accessToken: string,
    itemId: string,
    status: MercadoLibreWritableStatus,
    sellerContact: PortalSellerContact,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreItem>;
  /**
   * `GET /items/{id}/description`: el texto plano, o `null` si el ítem no tiene descripción (404,
   * NO VERIFICADO). Es una lectura: la retoma la consulta antes de `addDescription`, que falla sobre
   * una descripción que ya existe (spec F4 §4.8, paso 3).
   */
  getDescription(
    accessToken: string,
    itemId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<string | null>;
  /**
   * `POST /items/{id}/description` con texto plano (nota §4.1); sobre una que ya existe, falla. No
   * manda `seller_contact`: si un sub-recurso del ítem también lo exige, NO VERIFICADO (nota §4.2).
   */
  addDescription(
    accessToken: string,
    itemId: string,
    plainText: string,
    options?: MercadoLibreCallOptions,
  ): Promise<void>;
  /**
   * `PUT /items/{id}/address_line_by_reference`, sin cuerpo: oculta la dirección exacta (D7). Sin
   * `seller_contact`, como `addDescription` (NO VERIFICADO).
   */
  hideAddress(
    accessToken: string,
    itemId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<void>;
  /**
   * `GET /moderations/last_moderation/{id}-ITM`: la última moderación del ítem, para explicar una
   * pausa (spec F4 §4.9). `null` si no tiene (404 o una lista vacía, NO VERIFICADO). Solo lee.
   */
  getLastModeration(
    accessToken: string,
    itemId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreModeration | null>;
  /**
   * `GET /users/{id}/items/search?sku=…`: los ids de los ítems del vendedor con ese
   * `seller_custom_field` (doc "Ítems y Búsquedas", leída el 2026-10-07). Sin `status`, sin filtro
   * de estado (visto con `ml:smoke`, nota §12.4); con `status`, solo ese estado (la retoma de T14
   * repite con `not_yet_active` y `paused`, porque si la búsqueda sin estado los trae sigue sin
   * verificarse).
   */
  findBySellerCustomField(
    accessToken: string,
    userId: string,
    sellerCustomField: string,
    options?: MercadoLibreCallOptions & { status?: MercadoLibreSearchStatus },
  ): Promise<string[]>;
  /**
   * `GET /users/{id}/items/search` con un estado opcional y, si se pide, los filtros
   * (`include_filters=true`). Solo lee. `ml:smoke` (F4-T10) la usa para ver qué estados trae sin
   * `status`; T14 decide con eso cómo encuentra un ítem recién creado.
   */
  searchItems(
    accessToken: string,
    userId: string,
    query?: MercadoLibreItemSearchQuery,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreItemSearch>;
}

const nullableText = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const textList = z
  .array(z.string())
  .nullish()
  .catch(null)
  .transform((value) => value ?? []);
/**
 * Una fecha de Mercado Libre: ISO con zona (`…-03:00` o `Z`), como la exige `remoteStateSchema` de
 * core. Otra forma queda en `null`, para que guardar el estado no falle después de cerrar un aviso.
 */
const dateText = z.iso
  .datetime({ offset: true })
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);

const itemSchema = z
  .object({
    id: z.string().regex(ITEM_ID),
    permalink: nullableText,
    status: z.string().min(1),
    sub_status: textList,
    start_time: dateText,
    stop_time: dateText,
    expiration_time: dateText,
    last_updated: dateText,
    tags: textList,
    listing_source: nullableText,
    seller_custom_field: nullableText,
    warnings: z.unknown().optional(),
    cause: z.unknown().optional(),
  })
  .transform(
    (item): MercadoLibreItem => ({
      id: item.id,
      permalink: item.permalink,
      status: item.status,
      subStatus: item.sub_status,
      startTime: item.start_time,
      stopTime: item.stop_time,
      expirationTime: item.expiration_time,
      lastUpdated: item.last_updated,
      tags: item.tags,
      listingSource: item.listing_source,
      sellerCustomField: item.seller_custom_field,
      // De `warnings`, todo lo que no diga ser un error (puede venir sin `type`); de `cause[]` en una
      // respuesta que salió bien, solo las marcadas como advertencia.
      warnings: [
        ...parseCauses(item.warnings).filter((cause) => cause.type !== "error"),
        ...parseCauses(item.cause).filter((cause) => cause.type === "warning"),
      ].slice(0, MAX_CAUSES),
    }),
  );

const searchSchema = z.object({ results: z.array(z.string().regex(ITEM_ID)) });

/** Un id de un filtro o de su valor: un identificador, nunca un texto libre. */
const filterId = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const filterValueSchema = z.object({
  id: filterId,
  name: z
    .string()
    .max(100)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  results: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
});
const filterSchema = z.object({
  id: filterId,
  values: z
    .array(z.unknown())
    .nullish()
    .catch(null)
    .transform((values) =>
      (values ?? []).flatMap((value) => {
        const parsed = filterValueSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});
/** Los filtros que se entienden; los demás quedan fuera (es información, no define nada). */
const filtersSchema = z
  .array(z.unknown())
  .nullish()
  .catch(null)
  .transform((filters) =>
    (filters ?? []).flatMap((filter) => {
      const parsed = filterSchema.safeParse(filter);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const itemSearchSchema = z
  .object({
    results: z.array(z.string().regex(ITEM_ID)),
    paging: z
      .object({ total: z.number().int().nonnegative().nullish().catch(null) })
      .nullish()
      .catch(null),
    filters: filtersSchema,
    available_filters: filtersSchema,
  })
  .transform(
    (search): MercadoLibreItemSearch => ({
      total: search.paging?.total ?? null,
      results: search.results,
      filters: search.filters,
      availableFilters: search.available_filters,
    }),
  );
/** La respuesta es una lista (la doc muestra una sola entrada): se toma la primera. */
const moderationsSchema = z.array(
  z.object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .nullish()
      .catch(null)
      .transform((value) => value ?? null),
  }),
);
const descriptionSchema = z.object({
  plain_text: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
});

/** El `seller_contact` como lo pide Mercado Libre (nota §4.2): solo dígitos y sin los nulos. */
export function sellerContactBody(contact: PortalSellerContact): Record<string, string> {
  return {
    ...(contact.contact === null ? {} : { contact: contact.contact }),
    ...(contact.email === null ? {} : { email: contact.email }),
    country_code2: contact.countryCode2,
    phone2: contact.phone2,
  };
}

export function createMercadoLibreItems(options: MercadoLibreHttpOptions = {}): MercadoLibreItems {
  const origin = options.origin ?? MERCADOLIBRE_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? MERCADOLIBRE_REQUEST_TIMEOUT_MS;

  const call = (
    name: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    accessToken: string,
    body: RequestBody | undefined,
    { signal }: MercadoLibreCallOptions = {},
  ) =>
    mercadoLibreRequest(
      name,
      new URL(path, origin),
      { method, accessToken, ...(body === undefined ? {} : { body }) },
      { signal, timeoutMs },
    );

  /** El ítem que respondió debe ser el pedido: otro sería guardar el estado de un ítem ajeno. */
  const sameItem = (name: string, itemId: string, item: MercadoLibreItem) => {
    if (item.id !== itemId) throw MERCADOLIBRE_ERRORS.unexpectedResponse(name);
    return item;
  };

  /** La ruta de un ítem, o `ML_ID_INVALID` sin llamar. */
  const itemPath = (itemId: string, suffix = "") => {
    if (!ITEM_ID.test(itemId)) throw MERCADOLIBRE_ERRORS.invalidId("item");
    return `/items/${itemId}${suffix}`;
  };

  return {
    async create(accessToken, body, callOptions) {
      const response = await call(
        "createItem",
        "POST",
        "/items",
        accessToken,
        { json: body },
        callOptions,
      );
      return parseBody("createItem", itemSchema, response);
    },

    async get(accessToken, itemId, callOptions) {
      const path = itemPath(itemId);
      const response = await call("getItem", "GET", path, accessToken, undefined, callOptions);
      return sameItem("getItem", itemId, parseBody("getItem", itemSchema, response));
    },

    async setStatus(accessToken, itemId, status, sellerContact, callOptions) {
      // El tipo ya lo impide; esto lo asegura también para quien llama sin tipos (nunca `deleted`).
      if (!(MERCADOLIBRE_WRITABLE_STATUSES as readonly string[]).includes(status)) {
        throw MERCADOLIBRE_ERRORS.statusNotAllowed();
      }
      const path = itemPath(itemId);
      const response = await call(
        "setItemStatus",
        "PUT",
        path,
        accessToken,
        { json: { status, seller_contact: sellerContactBody(sellerContact) } },
        callOptions,
      );
      return sameItem("setItemStatus", itemId, parseBody("setItemStatus", itemSchema, response));
    },

    async getDescription(accessToken, itemId, callOptions) {
      const path = itemPath(itemId, "/description");
      let response: unknown;
      try {
        response = await call("getDescription", "GET", path, accessToken, undefined, callOptions);
      } catch (error) {
        if (isAppError(error) && error.details?.httpStatus === 404) return null;
        throw error;
      }
      return parseBody("getDescription", descriptionSchema, response).plain_text;
    },

    async getLastModeration(accessToken, itemId, callOptions) {
      // El id va en la ruta con el sufijo `-ITM` (la referencia de moderación de un ítem).
      if (!ITEM_ID.test(itemId)) throw MERCADOLIBRE_ERRORS.invalidId("item");
      const path = `/moderations/last_moderation/${itemId}-ITM`;
      let response: unknown;
      try {
        response = await call(
          "getLastModeration",
          "GET",
          path,
          accessToken,
          undefined,
          callOptions,
        );
      } catch (error) {
        if (isAppError(error) && error.details?.httpStatus === 404) return null;
        throw error;
      }
      const [last] = parseBody("getLastModeration", moderationsSchema, response);
      return last === undefined ? null : { name: last.name };
    },

    async addDescription(accessToken, itemId, plainText, callOptions) {
      const path = itemPath(itemId, "/description");
      await call(
        "addDescription",
        "POST",
        path,
        accessToken,
        { json: { plain_text: plainText } },
        callOptions,
      );
    },

    async hideAddress(accessToken, itemId, callOptions) {
      const path = itemPath(itemId, "/address_line_by_reference");
      await call("hideAddress", "PUT", path, accessToken, undefined, callOptions);
    },

    async findBySellerCustomField(accessToken, userId, sellerCustomField, callOptions = {}) {
      if (!USER_ID.test(userId)) throw MERCADOLIBRE_ERRORS.invalidId("user");
      const { status, ...rest } = callOptions;
      const query = new URLSearchParams({ sku: sellerCustomField });
      if (status !== undefined) {
        if (!(MERCADOLIBRE_SEARCH_STATUSES as readonly string[]).includes(status)) {
          throw MERCADOLIBRE_ERRORS.invalidId("status");
        }
        query.set("status", status);
      }
      const response = await call(
        "findBySellerCustomField",
        "GET",
        `/users/${userId}/items/search?${query}`,
        accessToken,
        undefined,
        rest,
      );
      return parseBody("findBySellerCustomField", searchSchema, response).results;
    },

    async searchItems(accessToken, userId, query = {}, callOptions) {
      if (!USER_ID.test(userId)) throw MERCADOLIBRE_ERRORS.invalidId("user");
      const params = new URLSearchParams();
      if (query.status !== undefined) {
        // El tipo ya lo limita; esto lo asegura para quien llama sin tipos (va en la URL).
        if (!(MERCADOLIBRE_SEARCH_STATUSES as readonly string[]).includes(query.status)) {
          throw MERCADOLIBRE_ERRORS.invalidId("status");
        }
        params.set("status", query.status);
      }
      if (query.includeFilters === true) params.set("include_filters", "true");
      const search = params.size === 0 ? "" : `?${params}`;
      const response = await call(
        "searchItems",
        "GET",
        `/users/${userId}/items/search${search}`,
        accessToken,
        undefined,
        callOptions,
      );
      return parseBody("searchItems", itemSearchSchema, response);
    },
  };
}
