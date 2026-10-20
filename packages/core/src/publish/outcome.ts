import { z } from "zod";
import { AppError, isAppError } from "../errors.js";
import type { PublishContext } from "../ports/publisher.js";

// El resultado dudoso (ADR-0029 punto 8, spec F9 §4.6): la red pudo haber publicado y no se sabe.
// El publisher guarda en su progreso "enviando" **antes** de la llamada que publica; un intento que
// encuentra ese progreso sin resultado no vuelve a llamar: devuelve `OUTCOME_UNKNOWN` (no
// reintentable) y el intento (`publishPublication`) deja la publicación en `outcome_unknown`. El
// operador la resuelve después (`resolvePublication`).

/** El código del resultado dudoso. */
export const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";

/**
 * Los códigos que el intento lleva a `outcome_unknown` en vez de a `failed`. Por ahora solo el
 * genérico: `IG_PUBLISH_OUTCOME_UNKNOWN` de Instagram sigue en `failed` (con su consejo de revisar
 * el perfil) hasta que exista la salida del operador, `POST /publications/:id/resolve` y
 * `publications resolve` (F9-T12 y T17); sin ella, una publicación de un aviso quedaría sin forma
 * de cerrarse desde el panel. Sumarlo aquí es una línea (y su consejo en `error-advice.ts`).
 */
export const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set([OUTCOME_UNKNOWN]);

/** Por qué no se sabe: un intento anterior quedó "enviando", el envío falló sin certeza o el progreso no se lee. */
export type OutcomeUnknownReason = "interrupted" | "send_failed" | "progress_unreadable";

/** `OUTCOME_UNKNOWN` (no reintentable): el mensaje dice qué hacer, sin datos de la publicación. */
export const outcomeUnknown = (reason: OutcomeUnknownReason, cause?: unknown) =>
  new AppError(
    OUTCOME_UNKNOWN,
    "No se sabe si la publicación salió: revisa la cuenta en la red y di si salió (con el enlace, si lo tienes) o si no salió",
    { details: { reason }, ...(cause === undefined ? {} : { cause }) },
  );

/** Si un error es un resultado dudoso (`OUTCOME_UNKNOWN_CODES`). */
export const isOutcomeUnknown = (error: unknown): boolean =>
  isAppError(error) && OUTCOME_UNKNOWN_CODES.has(error.code);

/**
 * Una publicación espera que el operador diga si salió: descartar, reintentar, programar, quitar
 * la aprobación y cerrar o archivar el aviso esperan esa palabra (como `MANUAL_CONFIRM_PENDING`).
 */
export const outcomeUnknownPending = (publicationId: string) =>
  new AppError(
    "OUTCOME_UNKNOWN_PENDING",
    "No se sabe si una publicación salió: revisa la red y di si salió (con el enlace) o si no salió antes de seguir",
    { details: { publicationId } },
  );

/** Lo que dejó una llamada que publicó: el id y el enlace en la red. */
export const sentResultSchema = z.object({
  externalId: z.string().min(1),
  externalUrl: z.string().nullable(),
});
export type SentResult = z.infer<typeof sentResultSchema>;

/**
 * El progreso "enviando" (`publications.progress.send`): cuándo empezó la llamada que publica y,
 * si respondió, su resultado. Sin `result`, no se sabe si salió. Laxo: el publisher de cada red
 * puede guardar lo suyo al lado (por ejemplo, los medios ya subidos).
 */
export const sendProgressSchema = z.looseObject({
  send: z.object({
    startedAt: z.iso.datetime(),
    result: sentResultSchema.optional(),
  }),
});
export type SendProgress = z.infer<typeof sendProgressSchema>;

/**
 * El traspaso a mano de una cuenta en modo `manual` fuera de Marketplace (ADR-0029 punto 9): el
 * intento dejó el texto y los medios listos (`awaiting_manual_confirm`) sin llamar a la red.
 */
export const manualHandoffProgressSchema = z.object({
  manual: z.object({
    /** `publications.attempts` del intento que lo dejó listo. */
    attempt: z.number().int().nonnegative(),
    simulated: z.boolean(),
    readyAt: z.iso.datetime(),
    /** Cuántos medios quedaron listos para subir a mano. */
    media: z.number().int().nonnegative(),
  }),
});
export type ManualHandoffProgress = z.infer<typeof manualHandoffProgressSchema>;

/**
 * El progreso de las redes de contenido de marca (X, LinkedIn, Discord y TikTok, spec F9 §4.6): el
 * "enviando" del publisher o el traspaso a mano. Cada publisher (F9-T14 a T16 y T26) puede
 * reemplazarlo por uno propio que lo extienda.
 */
export const socialProgressSchema = z.union([manualHandoffProgressSchema, sendProgressSchema]);

export type SendOnceOptions = {
  /** La llamada que publica: **una** sola, que devuelve el id y el enlace. */
  send: () => Promise<SentResult>;
  /**
   * Si el error de `send` prueba que la red **no** publicó (un 4xx de validación, un 429 o un 5xx
   * antes de aceptar): entonces se borra el "enviando" y el error sube tal cual (la cola reintenta
   * si es reintentable). Cualquier otro error (un corte, un tope de tiempo, una respuesta sin
   * leer) es `OUTCOME_UNKNOWN`. Sin esto, todo error lo es.
   */
  notSent?: (error: unknown) => boolean;
  now?: () => Date;
};

/**
 * La llamada que publica, una sola vez (ADR-0029 punto 8), para los publishers sin idempotencia en
 * la red (Discord, X): con el progreso del intento (`ctx.progress`),
 * 1. si ya trae un resultado, lo devuelve sin llamar (el intento anterior publicó y no alcanzó a
 *    guardar `published`);
 * 2. si trae "enviando" sin resultado, o un progreso que no se lee, `OUTCOME_UNKNOWN` sin llamar;
 * 3. si no, guarda "enviando" (si eso falla, el error sube: no se envió nada), llama a `send` y
 *    guarda el resultado. Si guardar el resultado falla, lo devuelve igual: el intento lo da por
 *    publicado, y si tampoco alcanza a guardarlo, el reintento verá "enviando" y lo dejará dudoso
 *    (nunca publica dos veces).
 * Un error de `send` que `notSent` reconoce borra el "enviando" y sube tal cual; cualquier otro es
 * `OUTCOME_UNKNOWN` (no reintentable), con el original como causa.
 */
export async function sendOnce(
  ctx: Pick<PublishContext, "progress" | "saveProgress">,
  { send, notSent, now = () => new Date() }: SendOnceOptions,
): Promise<SentResult> {
  if (ctx.progress !== null && ctx.progress !== undefined) {
    const saved = sendProgressSchema.safeParse(ctx.progress);
    if (!saved.success) throw outcomeUnknown("progress_unreadable");
    if (saved.data.send.result !== undefined) return saved.data.send.result;
    throw outcomeUnknown("interrupted");
  }
  const startedAt = now().toISOString();
  await ctx.saveProgress({ send: { startedAt } } satisfies SendProgress);
  let result: SentResult;
  try {
    result = await send();
  } catch (error) {
    if (notSent?.(error) === true) {
      // Si no se puede borrar, el reintento verá "enviando" y la dejará dudosa: nunca publica dos veces.
      await ctx.saveProgress(null).catch(() => undefined);
      throw error;
    }
    throw outcomeUnknown("send_failed", error);
  }
  await ctx
    .saveProgress({ send: { startedAt, result } } satisfies SendProgress)
    .catch(() => undefined);
  return result;
}
