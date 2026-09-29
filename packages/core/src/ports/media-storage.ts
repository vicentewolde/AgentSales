/** Metadatos de un objeto guardado. */
export type StoredObjectInfo = {
  size: number;
  contentType: string | undefined;
};

/**
 * Puerto de almacenamiento de archivos (ADR-0007). `path` es la ruta dentro del bucket, sin barra
 * inicial (ej. `brokers/{brokerId}/listings/{listingId}/original/{sha256}.jpg`).
 *
 * Semántica, pensada para jobs idempotentes:
 * - `put` sobrescribe si el objeto ya existe.
 * - `delete` no falla si el objeto no existe.
 * - Los errores son `AppError`: `STORAGE_NOT_FOUND` (no reintentable), `STORAGE_UNAVAILABLE`
 *   (reintentable: red o 5xx) y `STORAGE_ERROR` (no reintentable: credenciales, permisos).
 *
 * Trabaja con el archivo completo en memoria; F1 lo amplía con streams para videos grandes.
 */
export interface MediaStorage {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Lanza `STORAGE_NOT_FOUND` si el objeto no existe. */
  get(path: string): Promise<Uint8Array>;
  /** `null` si el objeto no existe. */
  head(path: string): Promise<StoredObjectInfo | null>;
  delete(path: string): Promise<void>;
  /** URL de lectura temporal; sin `ttlSeconds` usa el TTL configurado del adaptador. */
  signedReadUrl(path: string, ttlSeconds?: number): Promise<string>;
}
