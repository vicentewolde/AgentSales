import type { MediaKind } from "../enums.js";

/** Un archivo de medios aceptado: tipo permitido por extensión y verificado por su firma. */
export type MediaFile = {
  /** Ruta relativa a la raíz de medios, con `/` (ej. `depto-101/foto1.jpg`). */
  relPath: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  /** sha256 del contenido, en hexadecimal (64 caracteres en minúsculas). */
  sha256: string;
  /**
   * Abre el archivo para leerlo en streaming. Un fallo al leer (el archivo se borró o se movió)
   * es `AppError("MEDIA_FILE_UNREADABLE")`, no reintentable; `putStream` lo deja pasar tal cual.
   */
  open(): AsyncIterable<Uint8Array>;
};

/** Motivos por los que un archivo de la carpeta no se acepta (spec F1 §4.3). */
export const MEDIA_SKIP_REASONS = [
  /** Extensión fuera de jpg, jpeg, png, webp, heic, mp4 y mov. */
  "unsupported_type",
  /** La firma del archivo no corresponde a su extensión. */
  "signature_mismatch",
  /** Archivo vacío. */
  "empty",
  /** Video de más de `MAX_VIDEO_MB`. */
  "too_large",
  /** Subcarpeta, enlace simbólico u otro tipo que no es un archivo regular. */
  "not_a_file",
  /** No se pudo leer (permisos, error de disco). */
  "unreadable",
] as const;
export type MediaSkipReason = (typeof MEDIA_SKIP_REASONS)[number];

export type SkippedMediaFile = {
  relPath: string;
  reason: MediaSkipReason;
};

export type MediaFolderListing = {
  /** En orden natural por nombre (`2` antes de `10`). */
  files: MediaFile[];
  skipped: SkippedMediaFile[];
};

/**
 * Puerto de lectura de medios desde una raíz (la carpeta local o el zip ya extraído). `folder` es
 * relativo a esa raíz: `carpeta_medios` (o `id_propiedad`) de la fila, o `_marca` para el logo.
 *
 * - No recorre subcarpetas ni sigue enlaces simbólicos; ignora los archivos ocultos.
 * - Errores: `MEDIA_FOLDER_INVALID` si `folder` sale de la raíz o está vacío,
 *   `MEDIA_FOLDER_NOT_FOUND` si no existe y `MEDIA_FOLDER_UNREADABLE` si no se puede leer (permisos).
 *   Ninguno es reintentable; `ingestMedia` los convierte en una advertencia de la fila.
 * - Un archivo que no se acepta va a `skipped` con su motivo, no lanza.
 */
export interface MediaFileSource {
  list(folder: string): Promise<MediaFolderListing>;
}
