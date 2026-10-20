import { AppError } from "../errors.js";

// El enlace de un post de X (F9-T16), sin red: lo arma el publisher y lo lee la confirmación a mano
// (`parsePublishedUrl`). El id es el del post, **el mismo** que guarda el publisher como
// `external_id`, así confirmar o resolver a mano deja la publicación igual que si la hubiera
// publicado el sistema.

/**
 * `https://` + `x.com` o `twitter.com` (con `www.`, `mobile.` o sin nada) + `/<usuario>/status/<id>`
 * o `/i/status/<id>` o `/i/web/status/<id>`, con o sin `/` final, `/photo/1` o `/video/1`, y después
 * solo una consulta o un fragmento.
 */
const X_POST_URL =
  /^https:\/\/(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/(?:i\/web|i|(\w{1,50}))\/status(?:es)?\/(\d{1,30})(?:\/(?:photo|video)\/\d)?\/?(?:[?#]\S*)?$/i;

/** Un post de X reconocido: su id, el usuario (si el enlace lo traía) y el enlace limpio. */
export type XPostRef = { postId: string; username: string | null; url: string };

/**
 * El enlace limpio de un post: `https://x.com/<usuario>/status/<id>` o, sin usuario,
 * `https://x.com/i/status/<id>` (que X redirige al del usuario: INFERENCIA, `x.md` §4.1).
 */
export const xPostUrl = (postId: string, username: string | null): string =>
  username === null
    ? `https://x.com/i/status/${postId}`
    : `https://x.com/${username}/status/${postId}`;

/**
 * Reconoce el enlace de un post de X (el que copia el operador con «Copiar enlace» o de la barra del
 * navegador). Cualquier otra cosa es `PUBLISHED_URL_INVALID` (no reintentable, el mismo código que
 * las demás redes), sin repetir lo recibido en el mensaje.
 */
export function parseXPostUrl(value: string): XPostRef {
  const match = X_POST_URL.exec(value.trim());
  const postId = match?.[2];
  if (match === null || postId === undefined) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      "No es el enlace de un post de X: en el post, usa «Compartir» > «Copiar enlace» (x.com/<usuario>/status/<número>)",
      { details: { platform: "x" } },
    );
  }
  const username = match[1] ?? null;
  return { postId, username, url: xPostUrl(postId, username) };
}
