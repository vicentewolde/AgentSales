import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";
import { parseLinkedInPostUrl } from "../linkedin.js";
import { parseMarketplaceItemUrl } from "../marketplace/url.js";
import { parseTikTokVideoUrl } from "../tiktok/url.js";
import { parseXPostUrl } from "../x/post-url.js";

/**
 * `https://` + un host (letras, dígitos, puntos y guiones; sin usuario, clave ni puerto) + una ruta
 * opcional, y después solo una consulta o un fragmento. Con una expresión y no con `URL`: core no
 * carga los tipos de Node ni del navegador.
 */
const PUBLISHED_URL = /^(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s?#]*)?)(?:[?#]\S*)?$/i;

/** Largo máximo del enlace que se guarda (`external_url`). */
export const PUBLISHED_URL_MAX_LENGTH = 500;

/**
 * El enlace de un mensaje de Discord: `https://discord.com/channels/<servidor>/<canal>/<mensaje>`
 * (también `discordapp.com`, `www.`, `ptb.` y `canary.`, con o sin `/` final), y después solo una
 * consulta o un fragmento. Los tres son snowflakes (dígitos).
 */
const DISCORD_MESSAGE_URL =
  /^https:\/\/(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{1,30})\/(\d{1,30})\/(\d{1,30})\/?(?:[?#]\S*)?$/i;

/** Un mensaje de Discord reconocido: sus ids y su enlace limpio. */
export type DiscordMessageRef = {
  guildId: string;
  channelId: string;
  messageId: string;
  url: string;
};

/**
 * El enlace limpio de un mensaje de Discord, el que guarda el publisher (F9-T14) como
 * `external_url`. Que el cliente de Discord abra ese formato es INFERENCIA (`discord.md` §4.1).
 */
export const discordMessageUrl = (guildId: string, channelId: string, messageId: string) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/**
 * Reconoce el enlace de un mensaje de Discord (el que copia el operador con «Copiar enlace del
 * mensaje»), sin red: el id es el del mensaje, **el mismo** que guarda el publisher como
 * `external_id` (F9-T14), así confirmar o resolver a mano deja la publicación igual que si la
 * hubiera publicado el sistema. Cualquier otra cosa es `PUBLISHED_URL_INVALID` (no reintentable,
 * el mismo código que las demás redes), sin repetir lo recibido en el mensaje.
 */
export function parseDiscordMessageUrl(value: string): DiscordMessageRef {
  const match = DISCORD_MESSAGE_URL.exec(value.trim());
  const [, guildId, channelId, messageId] = match ?? [];
  if (guildId === undefined || channelId === undefined || messageId === undefined) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      "No es el enlace de un mensaje de Discord: en el mensaje, abre el menú (…) y usa «Copiar enlace del mensaje»",
      { details: { platform: "discord" } },
    );
  }
  return { guildId, channelId, messageId, url: discordMessageUrl(guildId, channelId, messageId) };
}

/** Lo publicado según el enlace que pegó el operador: el id en la red y el enlace limpio. */
export type PublishedRefFromUrl = { externalId: string; url: string };

/**
 * El enlace de lo publicado que pega el operador al confirmar o resolver (ADR-0029 puntos 8 y 9):
 * - Marketplace: `parseMarketplaceItemUrl` (el número del aviso; `MARKETPLACE_URL_INVALID`);
 * - Discord: `parseDiscordMessageUrl` (el id del mensaje, el mismo que guarda el publisher;
 *   `PUBLISHED_URL_INVALID`);
 * - X: `parseXPostUrl` (el id del post, el mismo que guarda el publisher, F9-T16;
 *   `PUBLISHED_URL_INVALID`);
 * - LinkedIn: `parseLinkedInPostUrl` (el URN del post, el formato que guarda el publisher, F9-T15;
 *   `PUBLISHED_URL_INVALID`);
 * - TikTok: `parseTikTokVideoUrl` (el id del video; el borrador lo publica el operador en la app,
 *   F9-T26; `PUBLISHED_URL_INVALID`, también con un enlace corto);
 * - las demás: un enlace `https` (sin usuario, clave ni puerto) de hasta 500 caracteres, sin la
 *   consulta ni el fragmento (traen datos de rastreo); el id es el mismo enlace limpio. Si no,
 *   `PUBLISHED_URL_INVALID` (no reintentable), sin repetir lo recibido en el mensaje.
 * Que el host sea el de la red lo revisa su publisher cuando exista (F9-T13, T15 y T16).
 */
export function parsePublishedUrl(platform: Platform, value: string): PublishedRefFromUrl {
  if (platform === "fb_marketplace") {
    const item = parseMarketplaceItemUrl(value);
    return { externalId: item.itemId, url: item.url };
  }
  if (platform === "discord") {
    const message = parseDiscordMessageUrl(value);
    return { externalId: message.messageId, url: message.url };
  }
  // X (F9-T16): el id del post, el mismo que guarda el publisher.
  if (platform === "x") {
    const post = parseXPostUrl(value);
    return { externalId: post.postId, url: post.url };
  }
  if (platform === "linkedin") {
    const post = parseLinkedInPostUrl(value);
    return { externalId: post.urn, url: post.url };
  }
  if (platform === "tiktok") {
    const video = parseTikTokVideoUrl(value);
    return { externalId: video.videoId, url: video.url };
  }
  const clean = PUBLISHED_URL.exec(value.trim())?.[1];
  if (clean === undefined || clean.length > PUBLISHED_URL_MAX_LENGTH) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      "No es el enlace de una publicación: cópialo de la barra del navegador (empieza con https://)",
      { details: { platform } },
    );
  }
  return { externalId: clean, url: clean };
}
