import { AppError } from "@agentsales/core";
import { z } from "zod";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { MERCADOLIBRE_ERRORS, type MercadoLibreErrorInfo } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
  parseBody,
} from "./http.js";

/** Una foto por subir: los bytes de la variante `pi_4x3` (JPEG, spec F4 §4.8, D4). */
export type MercadoLibrePictureFile = {
  bytes: Uint8Array;
  /** `image/jpeg` o `image/png` (nota §5). */
  mime: string;
  /** Nombre del archivo en el `multipart` (no es secreto ni lleva datos del aviso). */
  filename: string;
};

/**
 * Subida directa de fotos (`POST /pictures/items/upload`, nota §5): `multipart/form-data` con el
 * campo `file`. Devuelve el `id` que va en `pictures: [{ id }]` al crear el ítem.
 */
export interface MercadoLibrePictures {
  upload(
    accessToken: string,
    file: MercadoLibrePictureFile,
    options?: MercadoLibreCallOptions,
  ): Promise<{ id: string }>;
}

const uploadSchema = z.object({ id: z.string().min(1).max(200) });

/** Tipos que acepta Mercado Libre (nota §5). */
const PICTURE_TYPES = ["image/jpeg", "image/png"];

/**
 * El límite por minuto de la subida responde **400** "Bad_request" (doc de imágenes: "limitamos los
 * request por minuto (RPM) por cada app_id"), sin más detalle: un 400 sin causas que bloqueen y sin
 * otro código (`error` vacío o `bad_request`) es ese límite y se reintenta (spec F4 §4.8). Con
 * causas o con otro código (`unauthorized_application`, …), sigue la tabla general, para que una
 * foto mala o un permiso no gasten los reintentos como si fueran el límite.
 */
function classifyUploadError(info: MercadoLibreErrorInfo): AppError | null {
  const blocking = info.causes.some((cause) => cause.type !== "warning");
  const generic = info.error === null || info.error.toLowerCase() === "bad_request";
  if (info.httpStatus !== 400 || blocking || !generic) return null;
  return new AppError(
    "ML_RATE_LIMITED",
    "Mercado Libre limitó la subida de fotos por minuto: se reintenta",
    {
      retriable: true,
      details: { httpStatus: info.httpStatus, error: info.error, causes: info.causes },
    },
  );
}

export function createMercadoLibrePictures(
  options: MercadoLibreHttpOptions = {},
): MercadoLibrePictures {
  const origin = options.origin ?? MERCADOLIBRE_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? MERCADOLIBRE_REQUEST_TIMEOUT_MS;

  return {
    async upload(accessToken, file, { signal } = {}) {
      // Antes de llamar: una foto vacía o de otro tipo daría un 400 que parece el límite por minuto.
      if (file.bytes.length === 0) throw MERCADOLIBRE_ERRORS.invalidPicture("empty");
      if (!PICTURE_TYPES.includes(file.mime)) throw MERCADOLIBRE_ERRORS.invalidPicture("type");
      const form = new FormData();
      // Una copia con su propio `ArrayBuffer`: `Blob` no acepta uno compartido (`SharedArrayBuffer`).
      form.append(
        "file",
        new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
        file.filename,
      );
      const body = await mercadoLibreRequest(
        "uploadPicture",
        new URL("/pictures/items/upload", origin),
        { method: "POST", accessToken, body: { multipart: form }, classify: classifyUploadError },
        { signal, timeoutMs },
      );
      return { id: parseBody("uploadPicture", uploadSchema, body).id };
    },
  };
}
