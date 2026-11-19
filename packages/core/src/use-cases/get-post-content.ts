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
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Post } from "../post.js";
import { loadCardLanguages } from "../post-card-languages.js";
import type { Publication } from "../publication.js";
import { buildPostCheckContext, checkPostContent } from "../social/check.js";
import { postLanguages, postTextVisible } from "../social/post-languages.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";
import { postSourceHashes } from "./draft-post.js";
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
  /** Con `get`, también si el tema o el brief cambiaron después de redactar (`sourceChanged`). */
  contentRuns: Pick<ContentRunRepository, "latest"> & Partial<Pick<ContentRunRepository, "get">>;
  publications: Pick<PublicationRepository, "listBySubject">;
  /** El idioma de las tarjetas, para contar las imágenes de cada texto (sin él, no se separan). */
  postImageRuns?: Pick<PostImageRunRepository, "listByPost">;
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
  /**
   * Los idiomas en que escribe el post (`postLanguages`: los suyos o los de la marca), el principal
   * primero. Un texto aprobado de otro idioma se sigue mostrando: el panel y la CLI le ponen una nota.
   */
  languages: Language[];
  /**
   * Cuántos textos sin aprobar de un idioma quitado quedaron fuera de `contents` (no se borran:
   * vuelven si el idioma vuelve al post o a la marca).
   */
  hiddenTexts: number;
  /**
   * Si el tema o el brief del post cambiaron después de redactar alguno de sus textos vigentes
   * (la huella `postSource` de la corrida que lo redactó no calza con la del post). Los textos de
   * corridas anteriores a la huella no cuentan.
   */
  sourceChanged: { topic: boolean; brief: boolean };
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
  const cards = await loadCardLanguages(deps.postImageRuns, post.id);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", "No existe la marca del post", {
      details: { postId: post.id },
    });
  }
  const view = editorialProfileView(post.brokerId, profile);
  const languages = postLanguages(post, view.languages);
  // Un texto sin aprobar de un idioma quitado no se muestra ni da alertas (2026-11-15).
  const visible = current.filter((content) => postTextVisible(content, languages));
  const ctx = buildPostCheckContext({
    post,
    profile: view,
    broker,
    media,
    cards,
  });
  const contents = [...visible]
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
    sourceChanged: await sourceChangedOf(deps.contentRuns, post, current),
    publications: [...publications].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
    ),
    languages,
    hiddenTexts: current.length - visible.length,
  };
}

/** Compara la huella de cada corrida que redactó un texto vigente con la del post ahora. */
async function sourceChangedOf(
  runs: GetPostContentDeps["contentRuns"],
  post: Post,
  current: readonly Content[],
): Promise<{ topic: boolean; brief: boolean }> {
  const changed = { topic: false, brief: false };
  if (runs.get === undefined || current.length === 0) return changed;
  const now = postSourceHashes(post);
  for (const runId of new Set(current.map((content) => content.contentRunId))) {
    const source = (await runs.get(runId))?.report?.postSource;
    if (source === undefined) continue;
    if (source.topic !== now.topic) changed.topic = true;
    if (source.brief !== now.brief) changed.brief = true;
  }
  return changed;
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
