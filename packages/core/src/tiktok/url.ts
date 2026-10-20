import { AppError } from "../errors.js";

/**
 * El enlace de un video de TikTok: `https://www.tiktok.com/@<usuario>/video/<id>` (también sin
 * `www.` o con `m.`, con o sin `/` final), y después solo una consulta o un fragmento (traen datos
 * de rastreo). El usuario lleva letras, dígitos, `_` y `.`; el id son dígitos. Sin usuario, clave
 * ni puerto. Con una expresión y no con `URL`: core no carga los tipos de Node ni del navegador.
 */
const VIDEO_URL =
  /^https:\/\/(?:(?:www|m)\.)?tiktok\.com\/@([\w.]{1,64})\/video\/(\d{1,30})\/?(?:[?#]\S*)?$/i;

/**
 * Un enlace corto de TikTok (`vm.tiktok.com/…`, `vt.tiktok.com/…` o `www.tiktok.com/t/…`): solo
 * se resuelve con la red (una redirección), así que no se acepta: se pide el enlace largo.
 */
const SHORT_URL = /^https:\/\/(?:(?:vm|vt)\.tiktok\.com\/|(?:(?:www|m)\.)?tiktok\.com\/t\/)\S+$/i;

/** Un video de TikTok reconocido: el usuario, el id del video y su enlace limpio. */
export type TikTokVideoRef = { username: string; videoId: string; url: string };

/** El enlace limpio de un video, el que se guarda como `external_url`. */
export const tiktokVideoUrl = (username: string, videoId: string) =>
  `https://www.tiktok.com/@${username}/video/${videoId}`;

/**
 * Reconoce el enlace del video publicado que pega el operador al confirmar (F9-T26, ADR-0029 punto
 * 9), **sin red**: en TikTok el borrador lo termina y publica el operador en la app, y el sistema
 * no ve el video hasta que él lo confirma. El id es el del video (`external_id`). Un enlace corto
 * o cualquier otra cosa es `PUBLISHED_URL_INVALID` (no reintentable, el mismo código que las demás
 * redes), con qué hacer y sin repetir lo recibido.
 */
export function parseTikTokVideoUrl(value: string): TikTokVideoRef {
  const trimmed = value.trim();
  const [, username, videoId] = VIDEO_URL.exec(trimmed) ?? [];
  if (username === undefined || videoId === undefined) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      SHORT_URL.test(trimmed)
        ? "Ese es un enlace corto de TikTok: ábrelo en el navegador y copia el de la barra (tiktok.com/@usuario/video/…)"
        : "No es el enlace de un video de TikTok: en el video, usa Compartir > Copiar enlace y, si es corto, ábrelo en el navegador y copia el de la barra (tiktok.com/@usuario/video/…)",
      { details: { platform: "tiktok" } },
    );
  }
  return { username, videoId, url: tiktokVideoUrl(username, videoId) };
}
