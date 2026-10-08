import { z } from "zod";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { MERCADOLIBRE_ERRORS } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
} from "./http.js";

/** Un usuario de Mercado Libre: solo dígitos. Va en la ruta de la llamada. */
const USER_ID = /^\d{1,20}$/;
/** Una categoría de Mercado Libre Chile (`MLC1459`). Va en la ruta de la llamada. */
const CATEGORY_ID = /^MLC\d{1,20}$/;
/** El nombre de un campo de la respuesta: se muestra para conocer la forma, nunca su valor. */
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** El cupo de un tipo de publicación dentro de un paquete (`silver`, `gold`, …). */
export type MercadoLibrePackListing = {
  listingTypeId: string | null;
  available: number | null;
  used: number | null;
};

/**
 * Un paquete de publicación (nota §2): los contratados por el usuario o los que se pueden contratar
 * en una categoría. La forma de la respuesta no está verificada (la doc solo trae un ejemplo, nota
 * §2): lo que no venga o no se entienda queda en `null`, y `fields` dice qué campos trajo (sus
 * nombres, no sus valores), para completar la nota.
 */
export type MercadoLibrePack = {
  id: string | null;
  description: string | null;
  status: string | null;
  categoryId: string | null;
  remainingListings: number | null;
  listings: MercadoLibrePackListing[];
  dateExpires: string | null;
  price: number | null;
  currencyId: string | null;
  /** Días de vigencia del paquete. */
  duration: number | null;
  fields: string[];
};

/**
 * Una lista de paquetes: `container` es el campo que traía la lista (`null` si la respuesta era la
 * lista misma) y `fields`, los campos de la respuesta si no era una lista.
 */
export type MercadoLibrePackList = {
  packs: MercadoLibrePack[];
  container: string | null;
  fields: string[];
};

/**
 * Paquetes de publicación de Mercado Libre (nota §2), **solo lectura**: contratar es en el sitio, no
 * por API. Los usa `ml:smoke` (F4-T10) para ver el precio y el cupo `silver` antes de la prueba en
 * `live`. Errores: los `ML_*` de `mercadoLibreRequest`, más `ML_ID_INVALID` si un id no tiene la
 * forma de Mercado Libre (no se llama).
 */
export interface MercadoLibrePacks {
  /** `GET /users/{id}/classifieds_promotion_packs?package_content=publications`: los contratados. */
  userPacks(
    accessToken: string,
    userId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibrePackList>;
  /** `GET /categories/{id}/classifieds_promotion_packs`: los que se pueden contratar. */
  categoryPacks(
    accessToken: string,
    categoryId: string,
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibrePackList>;
}

const text = z
  .union([z.string().max(200), z.number().transform(String)])
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const amount = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .transform(Number),
  ])
  .nullish()
  .catch(null)
  .transform((value) =>
    value === null || value === undefined || !Number.isFinite(value) ? null : value,
  );

const fieldsOf = (value: unknown): string[] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value).filter((key) => FIELD_NAME.test(key))
    : [];

const listingSchema = z
  .object({
    listing_type_id: text,
    available_listings: amount,
    remaining_listings: amount,
    used_listings: amount,
  })
  .transform(
    (listing): MercadoLibrePackListing => ({
      listingTypeId: listing.listing_type_id,
      available: listing.available_listings ?? listing.remaining_listings,
      used: listing.used_listings,
    }),
  );

const packSchema = z
  .object({
    id: text,
    description: text,
    status: text,
    category_id: text,
    remaining_listings: amount,
    listing_details: z
      .array(z.unknown())
      .nullish()
      .catch(null)
      .transform((details) =>
        (details ?? []).flatMap((detail) => {
          const parsed = listingSchema.safeParse(detail);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    date_expires: text,
    price: amount,
    currency_id: text,
    duration: amount,
  })
  .transform(
    (pack): Omit<MercadoLibrePack, "fields"> => ({
      id: pack.id,
      description: pack.description,
      status: pack.status,
      categoryId: pack.category_id,
      remainingListings: pack.remaining_listings,
      listings: pack.listing_details,
      dateExpires: pack.date_expires,
      price: pack.price,
      currencyId: pack.currency_id,
      duration: pack.duration,
    }),
  );

/** Los paquetes de la respuesta: la lista, o la primera lista de objetos dentro de un objeto. */
function packListOf(body: unknown): MercadoLibrePackList {
  let container: string | null = null;
  let items: unknown[] | null = Array.isArray(body) ? body : null;
  if (items === null && typeof body === "object" && body !== null) {
    for (const [key, value] of Object.entries(body)) {
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "object" && item !== null)
      ) {
        if (!FIELD_NAME.test(key)) continue;
        container = key;
        items = value;
        break;
      }
    }
  }
  if (items === null) return { packs: [], container: null, fields: fieldsOf(body) };
  const packs = items.flatMap((item) => {
    const parsed = packSchema.safeParse(item);
    return parsed.success ? [{ ...parsed.data, fields: fieldsOf(item) }] : [];
  });
  return { packs, container, fields: container === null ? [] : fieldsOf(body) };
}

export function createMercadoLibrePacks(options: MercadoLibreHttpOptions = {}): MercadoLibrePacks {
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

  return {
    async userPacks(accessToken, userId, callOptions) {
      if (!USER_ID.test(userId)) throw MERCADOLIBRE_ERRORS.invalidId("user");
      const query = new URLSearchParams({ package_content: "publications" });
      const path = `/users/${userId}/classifieds_promotion_packs?${query}`;
      return packListOf(await get("userPacks", path, accessToken, callOptions));
    },

    async categoryPacks(accessToken, categoryId, callOptions) {
      if (!CATEGORY_ID.test(categoryId)) throw MERCADOLIBRE_ERRORS.invalidId("category");
      const path = `/categories/${categoryId}/classifieds_promotion_packs`;
      return packListOf(await get("categoryPacks", path, accessToken, callOptions));
    },
  };
}
