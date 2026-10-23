import type { PostMediaItem, PublicationView } from "@agentsales/api/contracts";
import { joinedPostText, type PostKind } from "@agentsales/core";

// LinkedIn a mano al mínimo trabajo (F9.5): lo puro del asistente — el enlace que abre el editor con
// el texto puesto, los medios que se bajan y cuándo una publicación quedó confirmada sin enlace.
// Todo es un enlace normal y el portapapeles: AgentSales no automatiza el navegador en LinkedIn.

/** El inicio de LinkedIn, donde está «Crear una publicación». */
export const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";

/**
 * El editor de publicación de LinkedIn, vacío. NO VERIFICADO (`docs/integraciones/linkedin.md`,
 * §10): que `shareActive=true` abra el editor lo dicen terceros, ninguna página oficial.
 */
export const LINKEDIN_EDITOR_URL = `${LINKEDIN_FEED_URL}?shareActive=true`;

/**
 * El largo máximo del enlace entero (con el texto codificado). Más largo, algunos navegadores,
 * servidores o redirecciones lo cortan: entonces el texto va solo por el portapapeles.
 */
export const LINKEDIN_SHARE_URL_MAX = 1800;

/** El enlace que abre el botón y si lleva el texto (`withText`) o abre el editor vacío. */
export type LinkedInOpenTarget = { href: string; withText: boolean };

/**
 * El enlace del botón «Copiar texto y abrir LinkedIn»: el editor con el texto ya puesto
 * (`?shareActive=true&text=<texto codificado>`). Si el enlace pasa de `LINKEDIN_SHARE_URL_MAX`, el
 * editor se abre vacío y el texto queda solo en el portapapeles (`withText: false`).
 */
export function linkedinOpenTarget(text: string): LinkedInOpenTarget {
  const href = `${LINKEDIN_EDITOR_URL}&text=${encodeURIComponent(text)}`;
  return href.length <= LINKEDIN_SHARE_URL_MAX
    ? { href, withText: true }
    : { href: LINKEDIN_EDITOR_URL, withText: false };
}

/** El texto aprobado que se copia y se manda (con sus hashtags). */
export const linkedinText = (content: { body: string; hashtags: readonly string[] }): string =>
  joinedPostText(content);

/** Un medio para bajar y poner a mano en el editor de LinkedIn. */
export type LinkedInDownload = {
  id: string;
  kind: PostMediaItem["kind"];
  /** La miniatura (se puede arrastrar); `null` si todavía no hay. */
  thumbUrl: string | null;
  /** La URL temporal del medio ya procesado: una foto `ig_4x5` o un reel. */
  url: string;
};

/**
 * Los medios ya procesados que lleva el post a LinkedIn, en su orden: todas las fotos de un post de
 * imagen o carrusel, o el primer video de uno de video. Un texto solo no lleva ninguno. Lo que
 * todavía no se procesa (`downloadUrl: null`) no entra.
 */
export function linkedinDownloads(
  media: readonly PostMediaItem[],
  postKind: PostKind,
): LinkedInDownload[] {
  if (postKind === "text") return [];
  const kind = postKind === "video" ? "video" : "image";
  const ready = media.flatMap((item) =>
    item.kind === kind && item.downloadUrl !== null
      ? [{ id: item.id, kind: item.kind, thumbUrl: item.thumbUrl, url: item.downloadUrl }]
      : [],
  );
  return kind === "video" ? ready.slice(0, 1) : ready;
}

/**
 * Una publicación de LinkedIn confirmada a mano **sin enlace**: publicada en vivo y sin enlace
 * guardado (confirmar sin enlace guarda un id propio y ningún enlace). Sin enlace no se puede abrir
 * el post desde Seguimiento.
 */
export const confirmedWithoutLink = (
  publication: Pick<PublicationView, "platform" | "status" | "dryRun" | "externalUrl">,
): boolean =>
  publication.platform === "linkedin" &&
  publication.status === "published" &&
  !publication.dryRun &&
  publication.externalUrl === null;

/** El texto que lo dice, igual en el post, en Seguimiento y en la portada. */
export const CONFIRMED_WITHOUT_LINK_TEXT = "Confirmada a mano, sin enlace";
