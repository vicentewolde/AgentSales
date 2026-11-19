import {
  type ContentRunStatus,
  isPostPlatform,
  isTerminalContentRun,
  LANGUAGES,
  type Language,
  type Platform,
  POST_PLATFORMS,
  type PostPlatform,
  type PostStatus,
  type PublicationStatus,
} from "../enums.js";
import { AppError } from "../errors.js";
import { PLATFORM_TEXT } from "../labels.js";
import { canDraftPost, type Post } from "../post.js";
import { kindProblem } from "./networks.js";

// Las redes de un post (`posts.platforms`, F9-T20 y T21): una sola regla en core para todos los
// caminos que publican (publicar, programar, aprobar, el reloj, empezar una publicación) y para lo
// que muestran la CLI y el panel. `null` = todas las redes de la marca.

/** Si el post publica en esa red: una red de posts que está entre las suyas (o todas, con `null`). */
export function postPublishesOn(post: Pick<Post, "platforms">, platform: Platform): boolean {
  if (!isPostPlatform(platform)) return false;
  return post.platforms === null || post.platforms.includes(platform);
}

/**
 * Si una publicación del post se muestra en Seguimiento y en la agenda: la de una de sus redes, o
 * una que ya salió (`published`) en una red que después se le quitó. Una red no marcada nunca
 * muestra borradores, errores ni alertas (2026-11-15). Sin `platforms` (`undefined`), todas.
 */
export function postShowsPublication(
  post: { platforms?: Post["platforms"] | undefined },
  publication: { platform: Platform; status: string },
): boolean {
  return (
    post.platforms === undefined ||
    postPublishesOn({ platforms: post.platforms }, publication.platform) ||
    publication.status === "published"
  );
}

/**
 * `POST_PLATFORM_EXCLUDED` (409): la red no está entre las del post. Sus textos no se borran, pero
 * no se aprueban, publican ni programan hasta que la red vuelva al post.
 */
export const postPlatformExcluded = (postId: string, platform: Platform) =>
  new AppError(
    "POST_PLATFORM_EXCLUDED",
    `${PLATFORM_TEXT[platform]} no está entre las redes del post: agrégala al post para aprobar, publicar o programar su texto`,
    { details: { postId, platform } },
  );

/** La red es una de las del post, o `POST_PLATFORM_EXCLUDED`. */
export function requirePostPlatform(
  post: Pick<Post, "id" | "platforms">,
  platform: Platform,
): void {
  if (!postPublishesOn(post, platform)) throw postPlatformExcluded(post.id, platform);
}

/** Lo que muestran la CLI y el panel de las redes de un post y sus textos. */
export type PostNetworkGaps = {
  /**
   * Redes del post (con lista propia) que sirven a su tipo (`kindProblem`) y no tienen texto, una
   * vez que la IA ya redactó (terminó bien o dejó textos) y no está redactando: una red agregada
   * después. Instagram en un post de solo texto no "falta": no sirve a ese tipo.
   */
  missing: PostPlatform[];
  /** Redes con texto que ya no están entre las del post: no se aprueban, publican ni programan. */
  excluded: PostPlatform[];
};

/** Las redes que faltan o sobran en los textos de un post (`PostNetworkGaps`). */
export function postNetworkGaps(params: {
  post: Pick<Post, "platforms" | "kind">;
  contents: readonly { platform: Platform }[];
  latestRun: { status: ContentRunStatus } | null;
}): PostNetworkGaps {
  const { post, contents, latestRun } = params;
  const drafted = new Set<Platform>(contents.map((content) => content.platform));
  const excluded = POST_PLATFORMS.filter(
    (platform) => drafted.has(platform) && !postPublishesOn(post, platform),
  );
  const running = latestRun !== null && !isTerminalContentRun(latestRun.status);
  const drafting = contents.length > 0 || latestRun?.status === "succeeded";
  const missing =
    post.platforms === null || running || !drafting
      ? []
      : post.platforms.filter(
          (platform) => !drafted.has(platform) && kindProblem(platform, post.kind) === null,
        );
  return { missing, excluded };
}

/**
 * Una idea aceptada que quedó sin textos y sin corrida en curso: "Redactar lo aceptado" (panel) y
 * `post draft` (CLI) le piden los textos. Una corrida terminada (bien, sin textos, o mal) cuenta igual.
 */
export function ideaNeedsDraft(idea: {
  status: PostStatus;
  texts: number;
  latestRun: { status: ContentRunStatus } | null;
}): boolean {
  return (
    idea.status === "draft" &&
    idea.texts === 0 &&
    (idea.latestRun === null || isTerminalContentRun(idea.latestRun.status))
  );
}

/**
 * Las redes que se le **agregaron** a un post ya redactado y no tienen texto (en ningún idioma): las
 * que la IA redacta sola al guardar la edición (`editPost`), sin tocar los demás textos. Nada si el
 * post es una idea o está archivado, si nunca se redactó (sin textos: sigue el flujo normal), si
 * pasa a todas las redes de la marca (`null`) o si la red no sirve a su tipo (`kindProblem`).
 * `before` son las redes que tenía (`null`: todas las de la marca, así que nada se "agrega").
 */
export function addedPlatformsToDraft(params: {
  before: readonly PostPlatform[] | null;
  post: Pick<Post, "platforms" | "kind" | "status">;
  contents: readonly { platform: Platform }[];
}): PostPlatform[] {
  const { before, post, contents } = params;
  if (!canDraftPost(post.status) || contents.length === 0) return [];
  if (post.platforms === null || before === null) return [];
  const drafted = new Set<Platform>(contents.map((content) => content.platform));
  return post.platforms.filter(
    (platform) =>
      !before.includes(platform) &&
      !drafted.has(platform) &&
      kindProblem(platform, post.kind) === null,
  );
}

/** Lo que el panel avisa arriba cuando el tipo del post no calza con sus medios o sus redes. */
export type PostKindIssues = {
  /** Lo que falta para el tipo («Falta la imagen…»); `null` si no falta nada. */
  media: string | null;
  /** Las redes del post (o con texto) que no sirven al tipo, con el motivo (`kindProblem`). */
  unfit: { platform: PostPlatform; message: string }[];
};

/**
 * Qué falta y qué no sirve para el tipo de un post (texto, imagen, carrusel o video): sus medios
 * originales (`images`, `videos`) y sus redes (las propias o, con todas las de la marca, las que
 * tienen texto). Lo muestra el detalle arriba, no solo dentro de cada texto.
 */
export function postKindIssues(params: {
  post: Pick<Post, "kind" | "platforms">;
  contents: readonly { platform: Platform }[];
  images: number;
  videos: number;
}): PostKindIssues {
  const { post, contents, images, videos } = params;
  let media: string | null = null;
  if (post.kind === "video" && videos === 0) {
    media = "Falta el video: el post es de video y aún no tiene ninguno.";
  } else if (post.kind === "image" && images === 0) {
    media = "Falta la imagen: el post es de imagen y aún no tiene ninguna.";
  } else if (post.kind === "carousel" && images < 2) {
    media =
      images === 0
        ? "Faltan las imágenes: el post es un carrusel y aún no tiene ninguna."
        : "Falta al menos otra imagen: un carrusel lleva 2 o más.";
  }
  const networks =
    post.platforms ??
    POST_PLATFORMS.filter((platform) => contents.some((content) => content.platform === platform));
  const unfit = networks.flatMap((platform) => {
    const message = kindProblem(platform, post.kind);
    return message === null ? [] : [{ platform, message }];
  });
  return { media, unfit };
}

/** Una red cuyas publicaciones programadas se mueven a la fecha nueva, con su espacio por idioma. */
export type RescheduleMove = {
  platform: PostPlatform;
  /** Los idiomas programados de esa red, en el orden de `LANGUAGES` (el primero sale a la hora). */
  languages: Language[];
  /** Los minutos entre un idioma y el siguiente, como estaban (0 con uno solo). */
  spacingMinutes: number;
};

export type RescheduleSuggestion = {
  /** Cuántas publicaciones están programadas. */
  count: number;
  /** Sus horas actuales, sin repetir y en orden. */
  times: Date[];
  moves: RescheduleMove[];
};

/**
 * Lo que se sugiere al cambiar la fecha planificada de un post con publicaciones programadas: moverlas
 * a la hora nueva (la primera de cada red a esa hora y los demás idiomas con el mismo espacio que
 * tenían). Nunca se mueven solas: el panel y la CLI lo ofrecen y el operador decide (programar de
 * nuevo usa `schedulePost`, que en vivo pide confirmación). `null` si no hay programadas o ya
 * están todas a esa hora.
 */
export function rescheduleSuggestion(
  publications: readonly {
    platform: Platform;
    language: Language;
    status: PublicationStatus;
    scheduledAt: Date | null;
  }[],
  at: Date,
): RescheduleSuggestion | null {
  const scheduled = publications.filter(
    (publication): publication is typeof publication & { scheduledAt: Date } =>
      publication.status === "scheduled" &&
      publication.scheduledAt !== null &&
      isPostPlatform(publication.platform),
  );
  if (scheduled.length === 0) return null;
  const moves: RescheduleMove[] = [];
  let moved = false;
  for (const platform of POST_PLATFORMS) {
    const own = scheduled.filter((publication) => publication.platform === platform);
    if (own.length === 0) continue;
    const languages = LANGUAGES.filter((language) =>
      own.some((publication) => publication.language === language),
    );
    const times = own.map((publication) => publication.scheduledAt.getTime());
    const first = Math.min(...times);
    const spacingMinutes =
      languages.length > 1
        ? Math.round((Math.max(...times) - first) / 60_000 / (languages.length - 1))
        : 0;
    if (first !== at.getTime()) moved = true;
    moves.push({ platform, languages, spacingMinutes });
  }
  if (!moved) return null;
  const times = [...new Set(scheduled.map((publication) => publication.scheduledAt.getTime()))]
    .sort((a, b) => a - b)
    .map((time) => new Date(time));
  return { count: scheduled.length, times, moves };
}
