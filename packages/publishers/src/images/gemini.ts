import {
  AppError,
  IMAGE_AI_NOT_CHARGED,
  type ImageGenerator,
  POST_IMAGE_LIMITS,
} from "@agentsales/core";
import { z } from "zod";
import { combinedSignal, IMAGE_MIMES } from "./download.js";

// La IA de imágenes de Google (Nano Banana; F9.5-T25, ADR-0038 §1.3; nota
// `imagenes-y-videos-generados.md` §3): `generateContent` de la API de Gemini con la salida en
// imagen y la proporción pedida. El modelo y el precio vienen de la configuración (cambian seguido).
// La forma exacta del pedido y de la respuesta con `gemini-nano-banana-2.1` es NO VERIFICADA hasta
// la prueba del operador (nota §7, prueba 2).

/** La API de Gemini (modelos). */
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
/** Una imagen puede tardar; el job tiene 30 min. */
const DEFAULT_TIMEOUT_MS = 120_000;

export type GeminiImagesOptions = {
  /** `GEMINI_API_KEY`: va en la cabecera `x-goog-api-key`, nunca en la URL ni en un error. */
  apiKey: string;
  /** `IMAGE_AI_MODEL`. */
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const partSchema = z.object({
  text: z.string().optional(),
  inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
});
const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(partSchema).default([]) }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .default([]),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  modelVersion: z.string().optional(),
});
const errorSchema = z.object({
  error: z.object({ status: z.string().optional(), message: z.string().optional() }),
});

/** Los motivos de término que son un bloqueo por las reglas del proveedor. */
const BLOCKED_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

const unavailable = (detail: string) =>
  new AppError("IMAGE_AI_UNAVAILABLE", `La IA de imágenes no respondió (${detail})`, {
    retriable: true,
  });
// `details.charged: false` (`IMAGE_AI_NOT_CHARGED`): Google rechazó el pedido antes de generar, así
// que no cobró y core devuelve la reserva. Lo demás (sin red, tope de tiempo, 5xx, una respuesta sin
// imagen o un bloqueo de la imagen ya hecha) se da por cobrado: se sobreestima, nunca se anota 0.
const rateLimited = () =>
  new AppError(
    "IMAGE_AI_RATE_LIMITED",
    "La IA de imágenes recibió demasiados pedidos o llegó a su cuota: espera un rato y vuelve a intentarlo",
    { retriable: true, details: IMAGE_AI_NOT_CHARGED },
  );
const authInvalid = () =>
  new AppError(
    "IMAGE_AI_AUTH_INVALID",
    "Google rechazó GEMINI_API_KEY: revisa que esté bien copiada en el servidor y que la API de Gemini tenga facturación",
    { details: IMAGE_AI_NOT_CHARGED },
  );
const blocked = (charged: boolean) =>
  new AppError(
    "IMAGE_AI_BLOCKED",
    "La IA no hizo la imagen por sus reglas de contenido: cambia la indicación y vuelve a intentarlo",
    charged ? {} : { details: IMAGE_AI_NOT_CHARGED },
  );
const rejected = (status: string | undefined) =>
  new AppError(
    "IMAGE_AI_REQUEST_REJECTED",
    "La IA de imágenes rechazó el pedido: revisa IMAGE_AI_MODEL o cambia la indicación",
    { details: { status: status ?? null, ...IMAGE_AI_NOT_CHARGED } },
  );
const unexpected = () =>
  new AppError("IMAGE_AI_UNEXPECTED_RESPONSE", "La IA de imágenes respondió sin una imagen");

/** El error de Google como `{ status }`, sin su mensaje (podría repetir la indicación). */
async function errorStatus(response: Response): Promise<{ status?: string; aboutKey: boolean }> {
  try {
    const parsed = errorSchema.safeParse(await response.json());
    if (!parsed.success) return { aboutKey: false };
    const { status, message } = parsed.data.error;
    return {
      ...(status === undefined ? {} : { status }),
      aboutKey: /api[ _-]?key/iu.test(message ?? ""),
    };
  } catch {
    return { aboutKey: false };
  }
}

/**
 * `ImageGenerator` con la API de Gemini: una imagen por pedido, en 1K y con la proporción del
 * post (4:5 o 9:16). Errores: 429 → `IMAGE_AI_RATE_LIMITED`; 401/403, o un 400 que habla de la
 * clave → `IMAGE_AI_AUTH_INVALID`; otro 4xx → `IMAGE_AI_REQUEST_REJECTED`; red, tope o 5xx →
 * `IMAGE_AI_UNAVAILABLE`; un bloqueo de contenido → `IMAGE_AI_BLOCKED`; sin imagen →
 * `IMAGE_AI_UNEXPECTED_RESPONSE`. Nunca deja la clave ni la indicación en un error.
 */
export function createGeminiImages(options: GeminiImagesOptions): ImageGenerator {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: "gemini",
    async generate({ prompt, format }, signal) {
      const url = `${GEMINI_API_URL}/${encodeURIComponent(options.model)}:generateContent`;
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE"],
              imageConfig: { aspectRatio: format, imageSize: "1K" },
            },
          }),
          signal: combinedSignal(timeoutMs, signal),
          redirect: "error",
        });
      } catch {
        throw unavailable("sin conexión o tardó demasiado");
      }
      if (response.status === 429) throw rateLimited();
      if (response.status >= 500) throw unavailable(`HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) throw authInvalid();
      if (!response.ok) {
        const { status, aboutKey } = await errorStatus(response);
        throw aboutKey ? authInvalid() : rejected(status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw unexpected();
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) throw unexpected();
      if (parsed.data.promptFeedback?.blockReason !== undefined) throw blocked(false);
      const [candidate] = parsed.data.candidates;
      const image = candidate?.content?.parts.find(
        (part) =>
          part.inlineData !== undefined &&
          (IMAGE_MIMES as readonly string[]).includes(part.inlineData.mimeType),
      )?.inlineData;
      if (image === undefined) {
        if (BLOCKED_REASONS.has(candidate?.finishReason ?? "")) throw blocked(true);
        throw unexpected();
      }
      // base64 de hasta 20 MB (unos 27 MB de texto): más que eso no es una imagen de 1K.
      if (image.data.length > Math.ceil((POST_IMAGE_LIMITS.downloadMaxBytes * 4) / 3) + 4) {
        throw unexpected();
      }
      const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
      if (bytes.length === 0) throw unexpected();
      return {
        bytes,
        mime: image.mimeType,
        model: parsed.data.modelVersion ?? options.model,
      };
    },
  };
}
