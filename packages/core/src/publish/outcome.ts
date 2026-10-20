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
 * el perfil). La salida del operador ya existe (`POST /publications/:id/resolve` y
 * `publications resolve`, F9-T12; en el panel, F9-T17), pero el panel la ofrece solo en el detalle
 * de un post, no en el de una propiedad: sumarlo aquí dejaría una publicación de un aviso sin forma
 * de cerrarse desde el panel. Cuando el panel la tenga también para las propiedades, es una línea
 * (y su consejo en `error-advice.ts`).
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

/** El "enviando" (`publications.progress.send`): cuándo empezó la llamada que publica y su resultado. */
export const sendStateSchema = z.object({
  startedAt: z.iso.datetime(),
  result: sentResultSchema.optional(),
});
export type SendState = z.infer<typeof sendStateSchema>;

/**
 * El progreso con "enviando" (`publications.progress.send`). Sin `result`, no se sabe si salió.
 * Laxo: el publisher de cada red guarda lo suyo al lado (por ejemplo, los medios ya subidos de X).
 */
export const sendProgressSchema = z.looseObject({ send: sendStateSchema });
export type SendProgress = z.infer<typeof sendProgressSchema>;

/** El traspaso a mano (`publications.progress.manual`): lo que dejó listo el intento. */
export const manualHandoffStateSchema = z.object({
  /** `publications.attempts` del intento que lo dejó listo. */
  attempt: z.number().int().nonnegative(),
  simulated: z.boolean(),
  readyAt: z.iso.datetime(),
  /** Cuántos medios quedaron listos para subir a mano. */
  media: z.number().int().nonnegative(),
});

/**
 * El traspaso a mano de una cuenta en modo `manual` fuera de Marketplace (ADR-0029 punto 9): el
 * intento dejó el texto y los medios listos (`awaiting_manual_confirm`) sin llamar a la red.
 */
export const manualHandoffProgressSchema = z.object({ manual: manualHandoffStateSchema });
export type ManualHandoffProgress = z.infer<typeof manualHandoffProgressSchema>;

/**
 * El progreso de las redes de contenido de marca (X, LinkedIn, Discord y TikTok, spec F9 §4.6): un
 * objeto con el "enviando" (`send`), el traspaso a mano (`manual`) y, al lado, lo que guarde cada
 * publisher (F9-T14 a T16 y T26), que puede reemplazarlo por uno propio que lo extienda. Laxo a
 * propósito: un esquema que descartara las claves desconocidas borraría el "enviando" o lo del
 * publisher al guardar.
 */
export const socialProgressSchema = z.looseObject({
  send: sendStateSchema.optional(),
  manual: manualHandoffStateSchema.optional(),
});

/**
 * Lo que dice un progreso de un envío anterior (ADR-0029 punto 8): `none` si no hay "enviando"
 * (sin progreso, o un objeto sin la clave `send`: lo de un publisher que todavía no envía, o un
 * traspaso a mano); `sent` con el resultado guardado; `unknown` si hay "enviando" sin resultado, o
 * un progreso que no se lee (no es un objeto, o `send` no calza). Lo usan `sendOnce` y el camino a
 * mano del intento, que no ofrece publicar a mano lo que pudo haber salido.
 */
export type PendingSend =
  | { kind: "none" }
  | { kind: "sent"; result: SentResult }
  | { kind: "unknown"; reason: "interrupted" | "progress_unreadable" };

export function pendingSend(progress: unknown): PendingSend {
  if (progress === null || progress === undefined) return { kind: "none" };
  if (typeof progress !== "object" || Array.isArray(progress)) {
    return { kind: "unknown", reason: "progress_unreadable" };
  }
  if (!("send" in progress) || progress.send === undefined) return { kind: "none" };
  const send = sendStateSchema.safeParse(progress.send);
  if (!send.success) return { kind: "unknown", reason: "progress_unreadable" };
  return send.data.result === undefined
    ? { kind: "unknown", reason: "interrupted" }
    : { kind: "sent", result: send.data.result };
}

/** El progreso sin `send` ni `manual`: lo propio del publisher, sobre lo que se suma el "enviando". */
function publisherPart(progress: unknown): Record<string, unknown> {
  if (progress === null || typeof progress !== "object" || Array.isArray(progress)) return {};
  const { send: _send, manual: _manual, ...rest } = progress as Record<string, unknown>;
  return rest;
}

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
  /**
   * El progreso vigente: lo último que el publisher guardó en **este** intento (por ejemplo, los
   * medios ya subidos). Por defecto, `ctx.progress` (el del inicio del intento): un publisher que
   * guardó algo antes de enviar lo pasa aquí, para que el "enviando" se sume a eso y no lo pise.
   */
  progress?: unknown;
  now?: () => Date;
};

/**
 * La llamada que publica, una sola vez (ADR-0029 punto 8), para los publishers sin idempotencia en
 * la red (Discord, X), mirando el progreso vigente (`options.progress`, o `ctx.progress`) con
 * `pendingSend`:
 * 1. con el resultado guardado, lo devuelve sin llamar (el intento anterior publicó y no alcanzó a
 *    guardar `published`);
 * 2. con "enviando" sin resultado, o un progreso que no se lee, `OUTCOME_UNKNOWN` sin llamar;
 * 3. sin "enviando" (sin progreso, o un objeto sin la clave `send`), **suma** "enviando" a lo que
 *    el publisher ya guardó (si guardarlo falla, el error sube: no se envió nada), llama a `send` y
 *    guarda el resultado, también sumado. Si guardar el resultado falla, lo devuelve igual: el
 *    intento lo da por publicado, y si tampoco alcanza a guardarlo, el reintento verá "enviando" y
 *    lo dejará dudoso (nunca publica dos veces).
 * Un error de `send` que `notSent` reconoce quita el "enviando" (deja lo del publisher) y sube tal
 * cual; cualquier otro es `OUTCOME_UNKNOWN` (no reintentable), con el original como causa. Un
 * `manual` de un traspaso anterior no se arrastra.
 */
export async function sendOnce(
  ctx: Pick<PublishContext, "progress" | "saveProgress">,
  options: SendOnceOptions,
): Promise<SentResult> {
  const { send, notSent, now = () => new Date() } = options;
  const current = "progress" in options ? options.progress : ctx.progress;
  const pending = pendingSend(current);
  if (pending.kind === "sent") return pending.result;
  if (pending.kind === "unknown") throw outcomeUnknown(pending.reason);
  const base = publisherPart(current);
  const startedAt = now().toISOString();
  await ctx.saveProgress({ ...base, send: { startedAt } } satisfies SendProgress);
  let result: SentResult;
  try {
    result = await send();
  } catch (error) {
    if (notSent?.(error) === true) {
      // Si no se puede quitar, el reintento verá "enviando" y la dejará dudosa: nunca publica dos veces.
      await ctx.saveProgress(Object.keys(base).length === 0 ? null : base).catch(() => undefined);
      throw error;
    }
    throw outcomeUnknown("send_failed", error);
  }
  await ctx
    .saveProgress({ ...base, send: { startedAt, result } } satisfies SendProgress)
    .catch(() => undefined);
  return result;
}
