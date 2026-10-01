import type { MediaKind } from "../enums.js";

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

/**
 * Medios (`media`). En F1 solo originales: únicos por `(listing_id, checksum)` y por
 * `storage_path` (spec F1 §4.5). Errores (`AppError`):
 * - `create` que choca con uno de esos únicos → `MEDIA_CONFLICT`, **reintentable**: dos intentos
 *   del job pueden solaparse, y el reintento lo encuentra con `listOriginals` o `findByStoragePath`;
 * - `arrange` con un id que no es original de ese aviso → `MEDIA_NOT_FOUND`, sin cambiar nada;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface MediaRepository {
  /** Originales de un aviso, por `sortOrder` y luego por id. */
  listOriginals(listingId: string): Promise<MediaRecord[]>;
  /** Para el logo, que no tiene aviso: su clave en R2 lleva el sha256. */
  findByStoragePath(storagePath: string): Promise<MediaRecord | null>;
  create(media: NewMedia): Promise<MediaRecord>;
  /** Fija orden y portada de varios originales de un aviso, todo o nada. */
  arrange(listingId: string, items: readonly MediaArrangement[]): Promise<void>;
}
