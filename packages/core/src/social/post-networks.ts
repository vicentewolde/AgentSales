import {
  type ContentRunStatus,
  isPostPlatform,
  isTerminalContentRun,
  type Platform,
  POST_PLATFORMS,
  type PostPlatform,
  type PostStatus,
} from "../enums.js";
import { AppError } from "../errors.js";
import { PLATFORM_TEXT } from "../labels.js";
import type { Post } from "../post.js";
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
