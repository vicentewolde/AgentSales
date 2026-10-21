import {
  type AbortSignalLike,
  type DiscordWebhookInfo,
  type DiscordWebhooks,
  discordWebhookParts,
  isAppError,
} from "@agentsales/core";
import { z } from "zod";
import {
  DISCORD_API_ORIGIN,
  DISCORD_API_VERSION,
  DISCORD_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import {
  DISCORD_ERRORS,
  discordHttpError,
  networkCodeOf,
  PRE_CONNECT_ERROR_CODES,
} from "./errors.js";

/** Opciones de cada llamada. */
export type DiscordCallOptions = { signal?: AbortSignalLike };

/** Un archivo adjunto: ya en memoria (se bajó de R2 antes de enviar). */
export type DiscordFile = { filename: string; mime: string; bytes: Uint8Array };

/** Lo que se envía: el texto (ya neutralizado) y los archivos, en orden. */
export type DiscordMessageRequest = { content: string; files: readonly DiscordFile[] };

/** El mensaje creado (con `?wait=true`). `guildId` solo si Discord lo trae (NO VERIFICADO). */
export type DiscordMessage = { id: string; channelId: string; guildId: string | null };

/**
 * Cliente de webhooks de Discord (spec F9 §4.6, F9-T14; `discord.md` §4): `get` lee el webhook sin
 * publicar (el puerto `DiscordWebhooks` de core, para conectar) y `execute` publica **un** mensaje
 * con `?wait=true` (para recibir su id). Sin idempotencia en Discord: `execute` no se repite solo
 * salvo ante un 429 (el publisher lo decide; un 429 no crea el mensaje). Ningún error lleva la URL,
 * el token, el texto ni el mensaje de Discord. No escribe logs.
 */
export interface DiscordWebhookClient extends DiscordWebhooks {
  execute(
    webhookUrl: string,
    message: DiscordMessageRequest,
    options?: DiscordCallOptions,
  ): Promise<DiscordMessage>;
}

export type DiscordWebhookOptions = {
  /** Por defecto `https://discord.com`. */
  origin?: string;
  /** Tope de cada llamada; por defecto `DISCORD_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
};

const snowflake = z
  .union([z.string().regex(/^\d{1,30}$/), z.number().int().nonnegative()])
  .transform(String);

const webhookSchema = z.looseObject({
  id: snowflake,
  name: z.string().nullish(),
  guild_id: snowflake.nullish(),
  channel_id: snowflake.nullish(),
});

const messageSchema = z.looseObject({
  id: snowflake,
  channel_id: snowflake,
  guild_id: snowflake.nullish(),
});

/**
 * Las menciones que procesa Discord: **ninguna**, siempre (spec F9 §4.4, `discord.md` §4.1 y §11).
 * Así ni un `@everyone` que se colara en el texto avisa a nadie.
 */
export const DISCORD_ALLOWED_MENTIONS = { parse: [] as string[] };

/** El cuerpo `payload_json` de un mensaje: el texto, las menciones apagadas y los adjuntos. */
export function discordPayload(message: DiscordMessageRequest): Record<string, unknown> {
  return {
    content: message.content,
    allowed_mentions: DISCORD_ALLOWED_MENTIONS,
    ...(message.files.length === 0
      ? {}
      : {
          attachments: message.files.map((file, id) => ({ id, filename: file.filename })),
        }),
  };
}

export function createDiscordWebhooks(options: DiscordWebhookOptions = {}): DiscordWebhookClient {
  const origin = options.origin ?? DISCORD_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? DISCORD_REQUEST_TIMEOUT_MS;
  /** La ruta con la versión explícita, armada con el id y el token (nunca va a un error). */
  const webhookTarget = (webhookUrl: string, query: Record<string, string> = {}) => {
    const { id, token } = webhookParts(webhookUrl);
    const target = new URL(`${origin}/api/${DISCORD_API_VERSION}/webhooks/${id}/${token}`);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
    return target;
  };

  return {
    async get(webhookUrl, callOptions = {}) {
      const body = await discordRequest(
        "getWebhook",
        webhookTarget(webhookUrl),
        { method: "GET" },
        { ...callOptions, timeoutMs },
      );
      const parsed = webhookSchema.safeParse(body);
      if (!parsed.success) throw DISCORD_ERRORS.unexpectedResponse("getWebhook");
      const info: DiscordWebhookInfo = {
        id: parsed.data.id,
        name: parsed.data.name?.trim() || `Webhook ${parsed.data.id}`,
        guildId: parsed.data.guild_id ?? null,
        channelId: parsed.data.channel_id ?? null,
      };
      return info;
    },
    async execute(webhookUrl, message, callOptions = {}) {
      const payload = discordPayload(message);
      let body: FormData | string;
      let contentType: string | null;
      if (message.files.length === 0) {
        body = JSON.stringify(payload);
        contentType = "application/json";
      } else {
        // `multipart/form-data` con `payload_json` y `files[n]` (`discord.md` §5.1); el separador
        // lo pone `fetch`.
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        message.files.forEach((file, index) => {
          form.append(
            `files[${index}]`,
            new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }),
            file.filename,
          );
        });
        body = form;
        contentType = null;
      }
      const response = await discordRequest(
        "executeWebhook",
        webhookTarget(webhookUrl, { wait: "true" }),
        { method: "POST", body, contentType },
        { ...callOptions, timeoutMs },
      );
      const parsed = messageSchema.safeParse(response);
      // Un 2xx sin el mensaje: Discord lo aceptó y no se sabe su id (el publisher lo deja dudoso).
      if (!parsed.success) throw DISCORD_ERRORS.unexpectedResponse("executeWebhook");
      return {
        id: parsed.data.id,
        channelId: parsed.data.channel_id,
        guildId: parsed.data.guild_id ?? null,
      };
    },
  };
}

/** El id y el token de la URL, o `CREDENTIALS_INVALID` (sin la URL). */
function webhookParts(webhookUrl: string) {
  try {
    return discordWebhookParts(webhookUrl);
  } catch {
    throw DISCORD_ERRORS.webhookMissing();
  }
}

type RequestSpec = {
  method: "GET" | "POST";
  body?: FormData | string;
  /** `null` en `multipart`: el separador lo pone `fetch`. */
  contentType?: string | null;
};

/**
 * Hace una llamada y devuelve el JSON, o lanza el `AppError` que corresponde (`discordHttpError`, y
 * los de `DISCORD_ERRORS` sin respuesta). Ningún error lleva la URL, la causa de `fetch` ni el
 * mensaje de Discord. No sigue redirecciones (reenviarían el cuerpo a otro lado).
 */
async function discordRequest(
  call: string,
  target: URL,
  init: RequestSpec,
  { signal, timeoutMs }: DiscordCallOptions & { timeoutMs: number },
): Promise<unknown> {
  if (signal?.aborted) throw DISCORD_ERRORS.aborted();
  const caller = new AbortController();
  const onAbort = () => caller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.contentType != null) headers["Content-Type"] = init.contentType;
  try {
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.any([caller.signal, timeout]),
      });
    } catch (failure) {
      if (caller.signal.aborted) throw DISCORD_ERRORS.aborted();
      if (timeout.aborted) throw DISCORD_ERRORS.unavailable("timeout");
      const code = networkCodeOf(failure);
      if (code !== null && PRE_CONNECT_ERROR_CODES.has(code)) throw DISCORD_ERRORS.unreachable();
      throw DISCORD_ERRORS.unavailable("network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (caller.signal.aborted) throw DISCORD_ERRORS.aborted();
      throw DISCORD_ERRORS.unavailable(timeout.aborted ? "timeout" : "network");
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Un cuerpo que no es JSON: lo decide el status.
    }
    if (!response.ok) {
      throw discordHttpError({
        httpStatus: response.status,
        body,
        retryAfterHeader: response.headers.get("retry-after"),
      });
    }
    if (body === null) throw DISCORD_ERRORS.unexpectedResponse(call);
    return body;
  } catch (failure) {
    if (isAppError(failure)) throw failure;
    throw DISCORD_ERRORS.unexpectedResponse(call);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
