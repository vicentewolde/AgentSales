import type { AbortSignalLike } from "../abort.js";
import type { PostImageFormat } from "../post-image.js";

// Los dos proveedores de imágenes de un post (F9.5-T25, ADR-0038 §2): la biblioteca (stock) y la
// IA. Los adaptadores (`pixabay`, `gemini`) viven en `@agentsales/publishers/images`; las pruebas
// usan los `fake` de `@agentsales/core/testing`. El modelo y el precio van en configuración.

/** Una foto de la biblioteca, para mostrarla y elegirla (sin la URL del archivo grande). */
export type StockPhoto = {
  /** El id del proveedor: lo que se guarda al elegir. */
  id: string;
  /** Miniatura para el panel (del proveedor; se muestra, nunca se publica). */
  previewUrl: string;
  /** Página de la foto en el proveedor. */
  pageUrl: string;
  /** Palabras clave del proveedor (sirven para el filtro «sin personas»). */
  tags: string[];
  width: number;
  height: number;
  /** Quién la subió (la licencia de Pixabay no exige crédito; se muestra igual). */
  author: string;
};

/** Un archivo descargado o generado, con el tipo que dijo quien lo entregó. */
export type ImageFile = { bytes: Uint8Array; mime: string };

/**
 * La biblioteca de fotos (Pixabay; ADR-0038 §1.2). Errores (`AppError`):
 * - `STOCK_RATE_LIMITED` (429): pasó el límite de peticiones por minuto;
 * - `STOCK_AUTH_INVALID`: la clave no sirve;
 * - `STOCK_UNAVAILABLE` (reintentable): no respondió;
 * - `STOCK_PHOTO_NOT_FOUND`: la foto elegida ya no está;
 * - `STOCK_DOWNLOAD_INVALID`: el archivo no es una imagen o pasa del tope;
 * - `STOCK_UNEXPECTED_RESPONSE`: respondió otra cosa.
 */
export interface StockPhotoProvider {
  readonly name: "pixabay" | "fake";
  search(query: { text: string; perPage: number }, signal?: AbortSignalLike): Promise<StockPhoto[]>;
  /** Descarga el archivo grande de una foto, por su id (nunca por una URL de afuera). */
  download(photoId: string, signal?: AbortSignalLike): Promise<ImageFile>;
}

/** Una imagen generada, con el modelo que la hizo. */
export type GeneratedImage = ImageFile & { model: string };

/**
 * La IA de imágenes (Nano Banana 2.1; ADR-0038 §1.3). La indicación ya trae las reglas (sin texto
 * ni personas). Errores (`AppError`):
 * - `IMAGE_AI_RATE_LIMITED` (429): límite de peticiones o de cuota;
 * - `IMAGE_AI_AUTH_INVALID`: la clave no sirve;
 * - `IMAGE_AI_UNAVAILABLE` (reintentable): no respondió o está sobrecargada;
 * - `IMAGE_AI_BLOCKED`: la indicación o la imagen se bloqueó por sus reglas (no se reintenta);
 * - `IMAGE_AI_UNEXPECTED_RESPONSE`: respondió sin imagen o con otra forma.
 */
export interface ImageGenerator {
  readonly name: "gemini" | "fake";
  generate(
    request: { prompt: string; format: PostImageFormat },
    signal?: AbortSignalLike,
  ): Promise<GeneratedImage>;
}
