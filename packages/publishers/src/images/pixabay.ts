import {
  type AbortSignalLike,
  AppError,
  POST_IMAGE_LIMITS,
  type StockPhoto,
  type StockPhotoProvider,
} from "@agentsales/core";
import { z } from "zod";
import { combinedSignal, IMAGE_MIMES, readCapped } from "./download.js";

// La biblioteca de Pixabay (F9.5-T25, ADR-0038 §1.2; nota `imagenes-y-videos-generados.md` §2):
// 100 peticiones por 60 s por clave, respuestas guardadas 24 h (lo pide Pixabay) y sin enlazar sus
// archivos: la foto elegida se descarga a R2. La licencia no exige crédito.

/** La API de Pixabay (fotos). */
export const PIXABAY_API_URL = "https://pixabay.com/api/";
/** Los hosts de donde se aceptan archivos (https). */
const DOWNLOAD_HOSTS = new Set(["pixabay.com", "cdn.pixabay.com"]);
/** Pixabay pide guardar las respuestas 24 h. */
const CACHE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type PixabayOptions = {
  /** `PIXABAY_API_KEY`: va en la consulta, así que la URL nunca se loguea ni va a un error. */
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Tope de una descarga (por defecto, el de core: 20 MB). */
  maxDownloadBytes?: number;
  now?: () => number;
};

const hitSchema = z.object({
  id: z.number().int().nonnegative(),
  pageURL: z.string(),
  tags: z.string().default(""),
  previewURL: z.string(),
  webformatURL: z.string().optional(),
  largeImageURL: z.string(),
  imageWidth: z.number(),
  imageHeight: z.number(),
  user: z.string().default(""),
});
const responseSchema = z.object({ totalHits: z.number(), hits: z.array(hitSchema) });
type Hit = z.infer<typeof hitSchema>;

const unavailable = (detail: string) =>
  new AppError("STOCK_UNAVAILABLE", `La biblioteca de fotos no respondió (${detail})`, {
    retriable: true,
  });
const rateLimited = () =>
  new AppError(
    "STOCK_RATE_LIMITED",
    "La biblioteca de fotos recibió demasiadas búsquedas: espera un minuto y vuelve a intentarlo",
    { retriable: true },
  );
const authInvalid = () =>
  new AppError(
    "STOCK_AUTH_INVALID",
    "Pixabay rechazó PIXABAY_API_KEY: revisa que esté bien copiada en el servidor",
  );
const unexpected = () =>
  new AppError(
    "STOCK_UNEXPECTED_RESPONSE",
    "La biblioteca de fotos respondió algo que no se entiende",
  );
const notFound = (photoId: string) =>
  new AppError("STOCK_PHOTO_NOT_FOUND", "Esa foto ya no está en la biblioteca: elige otra", {
    details: { photoId },
  });
const invalidDownload = () =>
  new AppError(
    "STOCK_DOWNLOAD_INVALID",
    "La foto de la biblioteca no es una imagen JPG, PNG ni WebP o pasa de 20 MB",
  );

/** Un archivo de Pixabay: https y de sus hosts (no se sigue una URL a otro lado). */
function allowedUrl(value: string): URL | null {
  const url = URL.parse(value);
  return url !== null && url.protocol === "https:" && DOWNLOAD_HOSTS.has(url.hostname) ? url : null;
}

const toPhoto = (hit: Hit): StockPhoto => ({
  id: String(hit.id),
  previewUrl: hit.webformatURL ?? hit.previewURL,
  pageUrl: hit.pageURL,
  tags: hit.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== ""),
  width: hit.imageWidth,
  height: hit.imageHeight,
  author: hit.user,
});

/**
 * `StockPhotoProvider` con la API de Pixabay: fotos verticales, en español y con `safesearch`.
 * Guarda 24 h cada búsqueda y la URL del archivo grande de cada foto vista; elegir una que no está
 * en memoria la vuelve a pedir por su `id`. Errores (sin la URL, que lleva la clave): 429 →
 * `STOCK_RATE_LIMITED`; 401/403, o un 400 que habla de la clave → `STOCK_AUTH_INVALID`; red, tope o
 * 5xx → `STOCK_UNAVAILABLE`; otra forma → `STOCK_UNEXPECTED_RESPONSE`.
 */
export function createPixabayStock(options: PixabayOptions): StockPhotoProvider {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxDownloadBytes ?? POST_IMAGE_LIMITS.downloadMaxBytes;
  const now = options.now ?? Date.now;
  const searches = new Map<string, { at: number; photos: StockPhoto[] }>();
  const files = new Map<string, { at: number; url: string }>();

  async function query(params: Record<string, string>, signal?: AbortSignalLike) {
    const url = new URL(PIXABAY_API_URL);
    url.searchParams.set("key", options.apiKey);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await doFetch(url, {
        signal: combinedSignal(timeoutMs, signal),
        redirect: "error",
      });
    } catch {
      throw unavailable("sin conexión o tardó demasiado");
    }
    if (response.status === 429) throw rateLimited();
    if (response.status === 401 || response.status === 403) throw authInvalid();
    if (response.status >= 500) throw unavailable(`HTTP ${response.status}`);
    if (response.status === 400) {
      const text = await response.text().catch(() => "");
      throw /key/iu.test(text) ? authInvalid() : unexpected();
    }
    if (!response.ok) throw unexpected();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unexpected();
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw unexpected();
    for (const hit of parsed.data.hits) {
      files.set(String(hit.id), { at: now(), url: hit.largeImageURL });
    }
    return parsed.data.hits;
  }

  return {
    name: "pixabay",

    async search({ text, perPage }, signal) {
      const q = text.trim().slice(0, POST_IMAGE_LIMITS.queryMaxChars);
      const size = Math.min(200, Math.max(3, perPage));
      const cacheKey = `${q.toLowerCase()}|${size}`;
      const cached = searches.get(cacheKey);
      if (cached !== undefined && now() - cached.at < CACHE_MS) return cached.photos;
      const hits = await query(
        {
          q,
          lang: "es",
          image_type: "photo",
          orientation: "vertical",
          safesearch: "true",
          per_page: String(size),
        },
        signal,
      );
      const photos = hits.filter((hit) => allowedUrl(hit.largeImageURL) !== null).map(toPhoto);
      searches.set(cacheKey, { at: now(), photos });
      return photos;
    },

    async download(photoId, signal) {
      if (!/^\d{1,20}$/u.test(photoId)) throw notFound(photoId);
      let file = files.get(photoId);
      if (file === undefined || now() - file.at >= CACHE_MS) {
        const hits = await query({ id: photoId }, signal);
        if (hits.length === 0) throw notFound(photoId);
        file = files.get(photoId);
      }
      const url = file === undefined ? null : allowedUrl(file.url);
      if (url === null) throw invalidDownload();
      let response: Response;
      try {
        response = await doFetch(url, {
          signal: combinedSignal(DOWNLOAD_TIMEOUT_MS, signal),
          redirect: "error",
        });
      } catch {
        throw unavailable("la descarga no terminó");
      }
      if (response.status === 404) throw notFound(photoId);
      if (response.status === 429) throw rateLimited();
      if (response.status >= 500) throw unavailable(`HTTP ${response.status}`);
      if (!response.ok) throw invalidDownload();
      const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!(IMAGE_MIMES as readonly string[]).includes(mime)) {
        await response.body?.cancel().catch(() => undefined);
        throw invalidDownload();
      }
      const bytes = await readCapped(response, maxBytes, invalidDownload);
      if (bytes.length === 0) throw invalidDownload();
      return { bytes, mime };
    },
  };
}
