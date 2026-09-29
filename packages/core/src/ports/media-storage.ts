/** Metadatos de un objeto guardado. */
export type StoredObjectInfo = {
  size: number;
  contentType: string | undefined;
};

/**
 * Puerto de almacenamiento de archivos (ADR-0007). `path` es la ruta dentro del bucket,
 * sin barra inicial (ej. `brokers/<id>/listings/<id>/original/foto-1.jpg`).
 */
export interface MediaStorage {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  /** `null` si el objeto no existe. */
  head(path: string): Promise<StoredObjectInfo | null>;
  delete(path: string): Promise<void>;
  /** URL de lectura temporal; sin `ttlSeconds` usa el TTL configurado del adaptador. */
  signedReadUrl(path: string, ttlSeconds?: number): Promise<string>;
}
