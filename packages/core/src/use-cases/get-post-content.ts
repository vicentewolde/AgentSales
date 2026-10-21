import type { CheckedContent } from "../content/check-context.js";
import type { Content, ContentRun } from "../content.js";
import { editorialProfileView } from "../editorial-profile.js";
import {
  isPostPlatform,
  LANGUAGES,
  type Language,
  type Platform,
  POST_PLATFORMS,
} from "../enums.js";
import { AppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository, ContentRunRepository } from "../ports/content-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Post } from "../post.js";
import type { Publication } from "../publication.js";
import { buildPostCheckContext, checkPostContent } from "../social/check.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";
import { assertPostAccess } from "./posts.js";

// Leer los textos de un post con su revisión, y encontrar el texto vigente de una red e idioma
// (spec F9 §4.10, F9-T12): lo que muestran `agentsales post show` y el panel (T17), y lo que buscan
// las rutas `/posts/:id/contents/:platform/:language`.

type Actor = Pick<User, "id" | "role" | "brokerId">;

export type GetPostContentDeps = {
  posts: Pick<PostRepository, "get">;
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  media: Pick<MediaRepository, "listBySubject">;
  contents: Pick<ContentRepository, "listCurrent">;
  contentRuns: Pick<ContentRunRepository, "latest">;
  publications: Pick<PublicationRepository, "listBySubject">;
};

export type PostContent = {
  post: Post;
  /**
   * El texto vigente de cada red e idioma con su revisión (`checkPostContent`, calculada al leer),
   * en el orden de `POST_PLATFORMS` y de `LANGUAGES`; vacío si nunca se pidieron.
   */
  contents: CheckedContent[];
  /** La corrida de textos más reciente, en cualquier estado. */
  latestRun: ContentRun | null;
  /** Todas las publicaciones del post, de todas sus redes e idiomas (las más nuevas primero). */
  publications: Publication[];
};

const order = (content: Pick<Content, "platform" | "language">) =>
  (POST_PLATFORMS as readonly Platform[]).indexOf(content.platform) * LANGUAGES.length +
  LANGUAGES.indexOf(content.language);

/**
 * Los textos de un post con su revisión, su última corrida y sus publicaciones (`GET /posts/:id`).
 * La revisión es la misma de aprobar (el perfil editorial de la marca, sus medios y el brief del
 * operador). Lo de otro corredor es `POST_NOT_FOUND`; sin `posts.manage`, `FORBIDDEN`.
 */
export async function getPostContent(
  deps: GetPostContentDeps,
  actor: Actor,
  postId: string,
): Promise<PostContent> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  const subject = postSubject(post.id);
  const [broker, profile, media, current, latestRun, publications] = await Promise.all([
    deps.brokers.findById(post.brokerId),
    deps.editorialProfiles.get(post.brokerId),
    deps.media.listBySubject(subject),
    deps.contents.listCurrent(subject),
    deps.contentRuns.latest(subject),
    deps.publications.listBySubject(subject),
  ]);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe la marca del post", {
      details: { postId: post.id },
    });
  }
  const ctx = buildPostCheckContext({
    post,
    profile: editorialProfileView(post.brokerId, profile),
    broker,
    media,
  });
  const contents = [...current]
    .sort((a, b) => order(a) - order(b))
    .map((content) => ({
      content,
      checks: isPostPlatform(content.platform)
        ? checkPostContent(content.platform, content, ctx)
        : [],
    }));
  return {
    post,
    contents,
    latestRun,
    publications: [...publications].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
    ),
  };
}

/**
 * El id del texto **vigente** de un post en una red e idioma (las rutas
 * `/posts/:id/contents/:platform/:language`): editar, aprobar o quitar la aprobación van después por
 * ese id, dentro del candado del post. Lo de otro corredor es `POST_NOT_FOUND`; sin texto en esa red
 * e idioma, `CONTENT_NOT_FOUND` con qué hacer.
 */
export async function postContentId(
  deps: { posts: Pick<PostRepository, "get">; contents: Pick<ContentRepository, "listCurrent"> },
  actor: Actor,
  { postId, platform, language }: { postId: string; platform: Platform; language: Language },
): Promise<string> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  const found = (await deps.contents.listCurrent(postSubject(post.id))).find(
    (content) => content.platform === platform && content.language === language,
  );
  if (found === undefined) {
    throw new AppError(
      "CONTENT_NOT_FOUND",
      `El post no tiene texto de ${platform} en ${language}: pide los textos (draft) o revisa la red y el idioma`,
      { details: { postId, platform, language } },
    );
  }
  return found.id;
}
