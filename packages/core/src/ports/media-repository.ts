import type { MediaKind } from "../enums.js";
import { AppError } from "../errors.js";

/** Un medio original guardado (`media` con `role = original`): lo que la ingesta necesita. */
export type MediaRecord = {
  id: string;
  /** `null` para los medios del corredor (logo). */
  listingId: string | null;
  brokerId: string;
  kind: MediaKind;
  storagePath: string;
  mime: string;
  bytes: number;
  /** sha256 del contenido, en hexadecimal. */
  checksum: string;
  sortOrder: number;
  isCover: boolean;
};

/** Medio original nuevo; `role` es siempre `original` en F1 (los derivados llegan en F2). */
export type NewMedia = Omit<MediaRecord, "id">;

/** Posición y portada de un medio de un aviso. */
export type MediaArrangement = { id: string; sortOrder: number; isCover: boolean };

/** `media.sort_order` es `integer` (int4). */
const MAX_SORT_ORDER = 2 ** 31 - 1;

/**
 * Valida un `arrange` antes de tocar nada; la usan todas las implementaciones. Ids repetidos, más
 * de una portada o un `sortOrder` que no es un entero entre 0 y el máximo de int4 son un bug de
 * quien llama: `MEDIA_ARRANGE_INVALID`, no reintentable.
 */
export function checkArrangement(items: readonly MediaArrangement[]): void {
  const badOrder = items.find(
    ({ sortOrder }) => !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > MAX_SORT_ORDER,
  );
  if (badOrder !== undefined) {
    throw new AppError("MEDIA_ARRANGE_INVALID", `Orden inválido: ${badOrder.sortOrder}`);
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new AppError("MEDIA_ARRANGE_INVALID", "Un medio aparece dos veces en el orden");
  }
  if (items.filter((item) => item.isCover).length > 1) {
    throw new AppError("MEDIA_ARRANGE_INVALID", "Hay más de una portada en el orden");
  }
}

/**
 * Medios (`media`). En F1 solo originales: todos los métodos ignoran los derivados (F2). Únicos por
 * `(listing_id, checksum)` y por
 * `storage_path` (spec F1 §4.5). Errores (`AppError`):
 * - `create` que choca con uno de esos únicos → `MEDIA_CONFLICT`, **reintentable**: dos intentos
 *   del job pueden solaparse, y el reintento lo encuentra con `listOriginals` o `findByStoragePath`;
 * - `arrange` con un id que no es original de ese aviso → `MEDIA_NOT_FOUND`, y con ids repetidos,
 *   más de una portada o un `sortOrder` inválido → `MEDIA_ARRANGE_INVALID`; sin cambiar nada. En
 *   Postgres, dos `arrange` del mismo aviso se serializan (bloqueo del aviso);
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface MediaRepository {
  /** Originales de un aviso, por `sortOrder` y luego por id. */
  listOriginals(listingId: string): Promise<MediaRecord[]>;
  /** Portadas (originales con `isCover`) de esos avisos, para la lista de la API. */
  listCovers(listingIds: readonly string[]): Promise<MediaRecord[]>;
  /** Para el logo, que no tiene aviso: su clave en R2 lleva el sha256. */
  findByStoragePath(storagePath: string): Promise<MediaRecord | null>;
  create(media: NewMedia): Promise<MediaRecord>;
  /**
   * Fija orden y portada de varios originales de un aviso, todo o nada. Hay **una sola portada**
   * por aviso: si un item trae `isCover`, los demás originales del aviso dejan de serlo, vengan o
   * no en `items`. Solo considera originales (`role = original`).
   */
  arrange(listingId: string, items: readonly MediaArrangement[]): Promise<void>;
}
