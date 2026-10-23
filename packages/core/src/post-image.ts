import { z } from "zod";
import { contentRunErrorSchema } from "./content.js";
import { AppError } from "./errors.js";

// Conseguir imágenes para un post sin medios (F9.5-T25, ADR-0038): tarjetas de la marca, una foto
// de la biblioteca (Pixabay) o una imagen con IA. Siempre a pedido; lo conseguido entra como un
// medio más del post, por el mismo camino que una foto subida.

/** De dónde sale la imagen, en el orden en que se ofrecen (ADR-0038 §1). */
export const POST_IMAGE_SOURCES = ["card", "stock", "ai"] as const;
export type PostImageSource = (typeof POST_IMAGE_SOURCES)[number];

/** Estados de un pedido de imágenes (`post_image_runs`), como los de una corrida. */
export const POST_IMAGE_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type PostImageRunStatus = (typeof POST_IMAGE_RUN_STATUSES)[number];

/** Proporciones de lo que se consigue: vertical de Instagram (4:5) o de reel e historia (9:16). */
export const POST_IMAGE_FORMATS = ["4:5", "9:16"] as const;
export type PostImageFormat = (typeof POST_IMAGE_FORMATS)[number];

/** Medidas de cada proporción, en píxeles (las de Instagram). */
export const POST_IMAGE_SIZES: Readonly<
  Record<PostImageFormat, { width: number; height: number }>
> = {
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

/** Topes de lo que se pide. */
export const POST_IMAGE_LIMITS = {
  /** La búsqueda en la biblioteca (Pixabay acepta hasta 100 caracteres). */
  queryMaxChars: 100,
  /** La indicación para la IA. */
  promptMaxChars: 1000,
  /** Cuántos resultados de la biblioteca se muestran. */
  stockResults: 12,
  /** Un archivo de la biblioteca o de la IA (más que esto no es una foto normal). */
  downloadMaxBytes: 20 * 1024 * 1024,
  /** Los pedidos de un post que se muestran. */
  runsShown: 5,
} as const;

/** Lo pedido (jsonb `request`): sin secretos ni URLs, solo lo que eligió el usuario. */
export const postImageRequestSchema = z.discriminatedUnion("source", [
  /** Tarjetas de la marca: en un post de video, además el video de las tarjetas (9:16). */
  z.object({
    source: z.literal("card"),
    format: z.enum(POST_IMAGE_FORMATS),
    /**
     * Quitar antes las tarjetas que este post ya tenía de pedidos anteriores (`removePostCards`):
     * solo ellas, nunca una foto o un video que el usuario subió.
     */
    replaceCards: z.boolean().optional(),
  }),
  /**
   * Una foto de la biblioteca: su id (el worker la vuelve a pedir a Pixabay con ese id, nunca con
   * una URL que mande el cliente) y la búsqueda con que se encontró.
   */
  z.object({
    source: z.literal("stock"),
    photoId: z.string().regex(/^\d{1,20}$/),
    query: z.string().trim().min(1).max(POST_IMAGE_LIMITS.queryMaxChars),
    format: z.enum(POST_IMAGE_FORMATS),
  }),
  /** Una imagen con IA, sin texto dentro (ADR-0038 §1.3). */
  z.object({
    source: z.literal("ai"),
    prompt: z.string().trim().min(3).max(POST_IMAGE_LIMITS.promptMaxChars),
    format: z.enum(POST_IMAGE_FORMATS),
  }),
]);
export type PostImageRequest = z.infer<typeof postImageRequestSchema>;

/** Un pedido de imágenes de un post (`post_image_runs`): el job `post.image` lo atiende. */
export const postImageRunSchema = z.object({
  id: z.string(),
  postId: z.string(),
  brokerId: z.string(),
  source: z.enum(POST_IMAGE_SOURCES),
  status: z.enum(POST_IMAGE_RUN_STATUSES),
  request: postImageRequestSchema,
  /** Los medios que quedaron en el post (en orden); vacío hasta que termina bien. */
  mediaIds: z.array(z.string()),
  /** Lo que costó (solo la IA; se anota apenas el proveedor entrega la imagen). */
  costUsd: z.number().nonnegative().nullable(),
  /** El modelo de IA que la hizo (`IMAGE_AI_MODEL` de ese momento). */
  model: z.string().nullable(),
  /** `{ code, message }` cuando `status = failed`. */
  error: contentRunErrorSchema.nullable(),
  createdBy: z.string().nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PostImageRun = z.infer<typeof postImageRunSchema>;

export const isActivePostImageRun = (run: Pick<PostImageRun, "status">): boolean =>
  run.status === "queued" || run.status === "running";

/** Los tipos de imagen que se guardan como medio de un post (los de una foto subida). */
const IMAGE_SIGNATURES: readonly {
  mime: string;
  extension: string;
  test: (b: Uint8Array) => boolean;
}[] = [
  {
    mime: "image/jpeg",
    extension: "jpg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    extension: "png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/webp",
    extension: "webp",
    test: (b) =>
      String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  },
];

/**
 * El tipo de una imagen por sus primeros bytes (no por lo que dice quien la entrega): JPEG, PNG o
 * WebP. `null` si no es ninguna (una página de error, un SVG, un GIF).
 */
export function sniffImage(bytes: Uint8Array): { mime: string; extension: string } | null {
  const found = IMAGE_SIGNATURES.find((signature) => signature.test(bytes));
  return found === undefined ? null : { mime: found.mime, extension: found.extension };
}

/** Lo que se agrega a toda indicación para la IA: sin texto ni personas (ADR-0038 §1.3). */
export const IMAGE_AI_RULES =
  "Sin texto, letras, números, logos, marcas ni marcas de agua dentro de la imagen. Sin personas reconocibles. Formato vertical para redes sociales.";

/** La indicación que se manda: la del usuario y las reglas. */
export const imageAiPrompt = (prompt: string): string => `${prompt.trim()}\n\n${IMAGE_AI_RULES}`;

/** La primera oración de un texto (hasta `max` caracteres), sin cortar una palabra. */
function firstSentence(text: string, max: number): string {
  const sentence = text.trim().split(/(?<=[.!?])\s/u)[0] ?? "";
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`;
}

/**
 * Lo que se propone buscar y pedir a la IA desde el post (editable en el panel y la CLI): el tema
 * y, para la IA, la primera oración del brief. Solo palabras del post; la IA de imagen recibe
 * además `IMAGE_AI_RULES`.
 */
export function postImageSuggestions(post: { topic: string; brief: string | null }): {
  query: string;
  prompt: string;
} {
  const topic = post.topic.trim();
  const brief = post.brief === null ? "" : firstSentence(post.brief, 240);
  return {
    query: topic.slice(0, POST_IMAGE_LIMITS.queryMaxChars),
    prompt:
      `Fotografía editorial, luminosa y realista que ilustre: ${topic}.${brief === "" ? "" : ` ${brief}`}`.slice(
        0,
        POST_IMAGE_LIMITS.promptMaxChars,
      ),
  };
}

/** `POST_IMAGE_NOT_NEEDED` (409): un post de solo texto no lleva imágenes. */
export const postImageNotNeeded = (postId: string) =>
  new AppError(
    "POST_IMAGE_NOT_NEEDED",
    "Este post es de solo texto: no necesita imágenes (cambia su tipo si quieres una)",
    { details: { postId } },
  );

/** `POST_IMAGE_RUN_ACTIVE` (409): ya se está consiguiendo una imagen para el post. */
export const postImageRunActive = (postId: string, runId: string | null) =>
  new AppError(
    "POST_IMAGE_RUN_ACTIVE",
    "Ya se está consiguiendo una imagen para este post: espera a que termine",
    { details: { postId, runId } },
  );

/**
 * `POST_CARDS_IN_USE` (409): las tarjetas ya están en una publicación aprobada, programada o
 * publicada; quitarlas la dejaría sin sus imágenes.
 */
export const postCardsInUse = (postId: string) =>
  new AppError(
    "POST_CARDS_IN_USE",
    "Las tarjetas ya están en una publicación aprobada, programada o publicada: quita la aprobación o cancela la publicación antes de cambiarlas",
    { details: { postId } },
  );

/** `POST_IMAGE_SOURCE_NOT_CONFIGURED` (503): falta la clave de la biblioteca o de la IA. */
export const postImageSourceNotConfigured = (source: Exclude<PostImageSource, "card">) =>
  new AppError(
    "POST_IMAGE_SOURCE_NOT_CONFIGURED",
    source === "stock"
      ? "La biblioteca de fotos no está configurada: falta PIXABAY_API_KEY en el servidor"
      : "Crear con IA no está configurado: falta GEMINI_API_KEY en el servidor",
    { details: { source } },
  );
