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

/**
 * Ítems de Mercado Libre (spec F4 §4.8, nota §4): crear, leer, cambiar el estado, cargar la
 * descripción, ocultar la dirección y buscar por `seller_custom_field`. **No borra**: no hay
 * método de borrado ni la marca de borrado del ítem, y el estado solo puede ser `paused`, `active`
 * o `closed` (cerrar basta, spec F4 §3). Errores: los `ML_*` de `mercadoLibreRequest`, más
 * `ML_ID_INVALID` si un id que va en la ruta no tiene la forma de Mercado Libre (no se llama).
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
   * `GET /users/{id}/items/search?sku=…`: los ids de los ítems del vendedor con ese
   * `seller_custom_field` (doc "Ítems y Búsquedas", leída el 2026-10-07). Sin filtro de estado; si
   * la búsqueda incluye los cerrados: NO VERIFICADO.
   */
  findBySellerCustomField(
    accessToken: string,
    userId: string,
    sellerCustomField: string,
    options?: MercadoLibreCallOptions,
  ): Promise<string[]>;
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

    async findBySellerCustomField(accessToken, userId, sellerCustomField, callOptions) {
      if (!USER_ID.test(userId)) throw MERCADOLIBRE_ERRORS.invalidId("user");
      const query = new URLSearchParams({ sku: sellerCustomField });
      const response = await call(
        "findBySellerCustomField",
        "GET",
        `/users/${userId}/items/search?${query}`,
        accessToken,
        undefined,
        callOptions,
      );
      return parseBody("findBySellerCustomField", searchSchema, response).results;
    },
  };
}
