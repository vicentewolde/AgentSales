import type { AbortSignalLike } from "../abort.js";

export type PutStreamOptions = {
  contentType: string;
  /** Tamaño exacto en bytes. */
  contentLength: number;
  /**
   * sha256 del contenido, en hexadecimal (64 caracteres). Si viene, el almacenamiento verifica
   * que lo subido calce y, si no, `STORAGE_CONTENT_MISMATCH` sin guardar nada (F1-T07b). Sin él,
   * solo se verifica el largo.
   */
  sha256?: string;
};

/** Metadatos de un objeto guardado. */
export type StoredObjectInfo = {
  size: number;
  contentType: string | undefined;
};

/** Un objeto de un listado por prefijo (`list`). */
export type ListedObject = {
  path: string;
  size: number;
  lastModified: Date;
};

export type SignedUploadOptions = {
  contentType: string;
  /** Tamaño exacto en bytes: la URL solo sirve para un cuerpo de ese largo. */
  contentLength: number;
  /**
   * sha256 del contenido, en hexadecimal (64 caracteres). Si viene, la URL lo exige: el cliente lo
   * manda en `x-amz-checksum-sha256` y R2 rechaza un contenido distinto (NO VERIFICADO hasta
   * `storage:check`, spec F8 §4.4).
   */
  sha256?: string;
  /** Vida de la URL (spec F8 §4.4: 1 h). */
  ttlSeconds: number;
};

/**
 * Una subida prefirmada (ADR-0025): un `PUT` a `url` con exactamente estas cabeceras (firmadas) y
 * un cuerpo de `contentLength` bytes. `Content-Length` no va en `headers`: lo pone el cliente al
 * mandar el cuerpo (el navegador no deja fijarlo a mano).
 */
export type SignedUpload = {
  url: string;
  headers: Record<string, string>;
};

/**
 * Puerto de almacenamiento de archivos (ADR-0007). `path` es la ruta dentro del bucket, sin barra
 * inicial (ej. `brokers/{brokerId}/listings/{listingId}/original/{sha256}.jpg`).
 *
 * Semántica, pensada para jobs idempotentes:
 * - `put` sobrescribe si el objeto ya existe.
 * - `delete` no falla si el objeto no existe.
 * - Los errores son `AppError`: `STORAGE_NOT_FOUND` (no reintentable), `STORAGE_UNAVAILABLE`
 *   (reintentable: red o 5xx), `STORAGE_ERROR` (no reintentable: credenciales, permisos) y, solo
 *   en `putStream`, `STORAGE_CONTENT_MISMATCH` (no reintentable: el contenido no es el anunciado).
 *   Este último es un problema del archivo, no de R2: la ingesta lo trata como una advertencia.
 *
 * `put` trabaja con el archivo completo en memoria; `putStream` lo sube en streaming (un solo PUT,
 * no multiparte), para videos de hasta `MAX_VIDEO_MB` (spec F1, D3).
 */
export interface MediaStorage {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  /**
   * Sube un archivo en streaming; sobrescribe si existe. `contentLength` es obligatorio (R2 no
   * acepta un largo desconocido sin multiparte). Si el stream trae más o menos bytes (el archivo
   * cambió mientras se subía), `STORAGE_CONTENT_MISMATCH`. Un stream no se puede rebobinar, así que el
   * adaptador **no** reintenta: el reintento es de quien llama, que vuelve a abrir el archivo.
   * Un `AppError` que lance el iterable (el lector del archivo) pasa tal cual. El contenido no se
   * verifica contra un hash salvo que venga `sha256`: con él, un contenido distinto da
   * `STORAGE_CONTENT_MISMATCH` sin guardar nada (F1-T07b).
   */
  putStream(
    path: string,
    body: AsyncIterable<Uint8Array>,
    options: PutStreamOptions,
  ): Promise<void>;
  /** Lanza `STORAGE_NOT_FOUND` si el objeto no existe. */
  get(path: string): Promise<Uint8Array>;
  /**
   * Lee un objeto en streaming, sin cargarlo completo en memoria (videos de hasta `MAX_VIDEO_MB`;
   * spec F2 §4.2). `STORAGE_NOT_FOUND` si no existe, al pedirlo. Un corte durante la lectura sale
   * del iterable como `STORAGE_UNAVAILABLE`, reintentable: el reintento es de quien llama, que lo
   * vuelve a pedir. La conexión se libera al leer hasta el final, al dejar de iterar (`break`), al
   * llamar a `return()` del iterador aunque no se haya leído nada, o al disparar `signal`. Quien
   * pide el stream y no lo va a leer debe hacer una de esas cosas.
   */
  getStream(
    path: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<AsyncIterable<Uint8Array>>;
  /** `null` si el objeto no existe. */
  head(path: string): Promise<StoredObjectInfo | null>;
  delete(path: string): Promise<void>;
  /** URL de lectura temporal; sin `ttlSeconds` usa el TTL configurado del adaptador. */
  signedReadUrl(path: string, ttlSeconds?: number): Promise<string>;
  /**
   * URL temporal para subir un objeto con un `PUT` directo desde el panel o la CLI (spec F8 §4.4,
   * ADR-0025), firmada con su tipo, su tamaño y, si viene, su sha256. Firmar no habla con R2.
   */
  signedUploadUrl(path: string, options: SignedUploadOptions): Promise<SignedUpload>;
  /**
   * Todos los objetos cuya ruta empieza con `prefix` (el adaptador recorre las páginas), en orden
   * de ruta. Un prefijo sin objetos es una lista vacía.
   */
  list(prefix: string): Promise<ListedObject[]>;
}
