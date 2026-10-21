import { z } from "zod";
import { AppError } from "./errors.js";

// LinkedIn, perfil personal (spec F9 §4.6 y §4.7, F9-T15; `docs/integraciones/linkedin.md`): lo
// que core sabe de la red sin hablar con ella. El cliente y el publisher viven en
// `@agentsales/publishers/linkedin`.

/**
 * Vigencia del token de LinkedIn (`linkedin.md` §3.2): 60 días, **sin refresco** para una app
 * self-serve. Si el canje no informa `expires_in`, se usa esta.
 */
export const LINKEDIN_TOKEN_DAYS = 60;

/** El permiso de Share on LinkedIn sin el que no se publica en el perfil personal (`linkedin.md` §2.1). */
export const LINKEDIN_PUBLISH_SCOPE = "w_member_social";

/**
 * Cómo publica una cuenta de LinkedIn (spec F9 §4.6, D5; ADR-0029 punto 9): `manual` por defecto
 * (el intento deja el texto y los medios listos y el operador publica a mano), `api` solo cuando
 * LinkedIn aclare su término §3.1(26) (prueba S3) y el token sirva en `/rest/posts` (S2).
 */
export const LINKEDIN_ACCOUNT_MODES = ["api", "manual"] as const;
export type LinkedInAccountMode = (typeof LINKEDIN_ACCOUNT_MODES)[number];

/** El modo de una cuenta recién conectada: a mano (D5). */
export const LINKEDIN_DEFAULT_MODE: LinkedInAccountMode = "manual";

/**
 * El id del miembro (`sub` de `/v2/userinfo`, `linkedin.md` §2.1): el `external_account_id` de la
 * cuenta y la parte final de `urn:li:person:<id>`. Letras, dígitos, `-` y `_`.
 */
export const linkedinMemberIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** El autor de un post del perfil personal (`linkedin.md` §4.2). Que sea el `sub` es INFERENCIA (S2). */
export const linkedinPersonUrn = (memberId: string): string => `urn:li:person:${memberId}`;

/**
 * `meta` de una cuenta de LinkedIn (sin secretos): el modo, los permisos que devolvió el canje
 * (`null` si no los informó) y cuándo se conectó.
 */
export const linkedinAccountMetaSchema = z.object({
  mode: z.enum(LINKEDIN_ACCOUNT_MODES),
  scopes: z.array(z.string()).nullable(),
  connectedAt: z.iso.datetime(),
});
export type LinkedInAccountMeta = z.infer<typeof linkedinAccountMetaSchema>;

/** Los tipos de URN de un post (`share` y `ugcPost` los crea la API; `activity` sale del enlace). */
const POST_URN_TYPES = { share: "share", ugcpost: "ugcPost", activity: "activity" } as const;

/** Un URN de post, ya en su forma canónica (`urn:li:share:123`). */
const POST_URN = /^urn:li:(share|ugcPost|activity):(\d{1,30})$/;

/** Si un texto es el URN de un post de LinkedIn (`urn:li:share|ugcPost|activity:<número>`). */
export const isLinkedInPostUrn = (value: string): boolean => POST_URN.test(value);

/**
 * El enlace de un post por su URN (`linkedin.md` §4.6): `https://www.linkedin.com/feed/update/<urn>/`.
 * Que abra con `urn:li:share:…` (y no solo con `ugcPost`) es INFERENCIA: lo confirma S2.
 */
export const linkedinPostUrl = (urn: string): string =>
  `https://www.linkedin.com/feed/update/${urn}/`;

/** Lo que se reconoce de un enlace de post: su URN canónico y el enlace limpio. */
export type LinkedInPostRef = { urn: string; url: string };

/** El host: `linkedin.com`, con `www.` o un subdominio de idioma (`cl.`, `es.`). */
const HOST = String.raw`https:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com`;
/** Lo que puede seguir al enlace: una `/` final y, después, solo una consulta o un fragmento. */
const TAIL = String.raw`\/?(?:[?#]\S*)?$`;
/** `/feed/update/<urn>/` o `/embed/feed/update/<urn>`, con el URN tal cual o codificado. */
const FEED_UPDATE = new RegExp(
  `^${HOST}\\/(?:embed\\/)?feed\\/update\\/urn(?::|%3A)li(?::|%3A)(share|ugcPost|activity)(?::|%3A)(\\d{1,30})${TAIL}`,
  "i",
);
/**
 * «Copiar enlace a la publicación»: `/posts/<usuario>_<texto>-activity-<número>-<sufijo>/`. El
 * número va al final, antes de un sufijo corto (sin él, también).
 */
const POSTS_LINK = new RegExp(
  `^${HOST}\\/posts\\/[^/?#\\s]*?-(share|ugcPost|activity)-(\\d{10,30})(?:-[A-Za-z0-9_-]{1,12})?${TAIL}`,
  "i",
);

/** El enlace corto que da «Copiar enlace a la publicación»: `https://lnkd.in/…` (no trae el número). */
const SHORT_LINK = /^https:\/\/lnkd\.in\//i;
const SHORT_LINK_MESSAGE =
  "Ese es el enlace corto de LinkedIn (lnkd.in) y no dice cuál es la publicación: ábrela (haz clic en su fecha) y copia el enlace de la barra de direcciones del navegador";
const INVALID_LINK_MESSAGE =
  "No es el enlace de una publicación de LinkedIn: ábrela (haz clic en su fecha) y copia el enlace de la barra de direcciones del navegador";

/**
 * Reconoce el enlace de un post de LinkedIn que pega el operador al confirmar o resolver (ADR-0029
 * puntos 8 y 9), sin red: devuelve el URN (`urn:li:share|ugcPost|activity:<número>`), que es el
 * mismo **formato** de `external_id` que guarda el publisher (el URN de `x-restli-id`), y el enlace
 * limpio `https://www.linkedin.com/feed/update/<urn>/`. Acepta `/feed/update/<urn>` (la barra del
 * navegador al abrir el post) y `/posts/…-activity-<número>-…` («Copiar enlace a la publicación»).
 * Ojo: el número de `activity` no es el del `share` que creó la API (`linkedin.md` §4.6): borrar por
 * la API con un URN `activity` no está verificado (S2). Cualquier otra cosa es
 * `PUBLISHED_URL_INVALID` (no reintentable), sin repetir lo recibido. Un `lnkd.in` (el enlace corto que
 * LinkedIn da hoy con «Copiar enlace a la publicación», sin el número: resolverlo pide red) tiene su
 * propio mensaje, que manda a copiar el enlace de la barra de direcciones.
 */
export function parseLinkedInPostUrl(value: string): LinkedInPostRef {
  const text = value.trim();
  const match = FEED_UPDATE.exec(text) ?? POSTS_LINK.exec(text);
  const [, rawType, id] = match ?? [];
  const type =
    rawType === undefined
      ? undefined
      : POST_URN_TYPES[rawType.toLowerCase() as keyof typeof POST_URN_TYPES];
  if (type === undefined || id === undefined) {
    throw new AppError(
      "PUBLISHED_URL_INVALID",
      SHORT_LINK.test(text) ? SHORT_LINK_MESSAGE : INVALID_LINK_MESSAGE,
      { details: { platform: "linkedin" } },
    );
  }
  const urn = `urn:li:${type}:${id}`;
  return { urn, url: linkedinPostUrl(urn) };
}
