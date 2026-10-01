export type PutStreamOptions = {
  contentType: string;
  /** Tamaño exacto en bytes. */
  contentLength: number;
};

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
 * `put` trabaja con el archivo completo en memoria; `putStream` lo sube en streaming (un solo PUT,
 * no multiparte), para videos de hasta `MAX_VIDEO_MB` (spec F1, D3).
 */
export interface MediaStorage {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  /**
   * Sube un archivo en streaming; sobrescribe si existe. `contentLength` es obligatorio (R2 no
   * acepta un largo desconocido sin multiparte). Si el stream trae más o menos bytes (el archivo
   * cambió mientras se subía), `STORAGE_ERROR`. Un stream no se puede rebobinar, así que el
   * adaptador **no** reintenta: el reintento es de quien llama, que vuelve a abrir el archivo.
   * Un `AppError` que lance el iterable (el lector del archivo) pasa tal cual. El contenido no se
   * verifica contra un hash (se decide en F1-T07).
   */
  putStream(
    path: string,
    body: AsyncIterable<Uint8Array>,
    options: PutStreamOptions,
  ): Promise<void>;
  /** Lanza `STORAGE_NOT_FOUND` si el objeto no existe. */
  get(path: string): Promise<Uint8Array>;
  /** `null` si el objeto no existe. */
  head(path: string): Promise<StoredObjectInfo | null>;
  delete(path: string): Promise<void>;
  /** URL de lectura temporal; sin `ttlSeconds` usa el TTL configurado del adaptador. */
  signedReadUrl(path: string, ttlSeconds?: number): Promise<string>;
}
