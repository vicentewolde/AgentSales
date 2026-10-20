import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import type { FieldDefinition } from "../field-definition.js";
import type { Listing } from "../listing.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { FieldDefinitionRepository } from "../ports/field-definition-repository.js";
import type { LockedRepositories } from "../ports/listing-lock.js";
import type { ListingRepository } from "../ports/listing-repository.js";
import type { PostLockedRepositories } from "../ports/post-lock.js";
import { canDraftPost, type Post } from "../post.js";
import { listingSubject, postSubject, type Subject, sameSubject } from "../subject.js";
import type { LockedSubject, SubjectLockedRepositories } from "../subject-lock.js";
import { type CheckedContent, checked, loadCheckContext } from "./check-context.js";

// Aprobar, quitar la aprobación y editar un texto (ADR-0014) sobre un sujeto (ADR-0029): una parte
// común (el texto existe y es el vigente de su canal e idioma) y lo propio de cada sujeto (la
// revisión editorial del aviso, con su ficha y sus campos; la del post, con su perfil).

/** Lo que se lee **antes** del candado: el texto, su aviso y las definiciones de campos. */
export type ContentLockDeps = {
  contents: Pick<ContentRepository, "get">;
  listings: Pick<ListingRepository, "get">;
  /** `LockedRepositories` no los trae (spec F3, T05): se leen fuera, antes de `run`. */
  fieldDefinitions: Pick<FieldDefinitionRepository, "list">;
};

/** "del aviso" o "del post", para los mensajes. */
const ofSubject = (subject: Subject) => (subject.kind === "listing" ? "del aviso" : "del post");

export const contentNotFound = (contentId: string) =>
  new AppError("CONTENT_NOT_FOUND", `No existe el texto ${contentId}`, { details: { contentId } });

/**
 * Antes del candado: el sujeto del texto y, si es un aviso, sus definiciones de campos (las pide la
 * revisión editorial). `CONTENT_NOT_FOUND` o `LISTING_NOT_FOUND` si falta alguno; un post que no
 * existe lo informa su candado (`POST_NOT_FOUND`).
 */
export async function beforeContentLock(
  deps: ContentLockDeps,
  contentId: string,
): Promise<{ subject: Subject; definitions: FieldDefinition[] }> {
  const content = await deps.contents.get(contentId);
  if (content === null) throw contentNotFound(contentId);
  if (content.subject.kind === "post") return { subject: content.subject, definitions: [] };
  const listing = await deps.listings.get(content.subject.id);
  if (listing === null) {
    throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${content.listingId}`, {
      details: { listingId: content.listingId },
    });
  }
  const definitions = await deps.fieldDefinitions.list({
    category: listing.category,
    brokerId: listing.brokerId,
  });
  return { subject: listingSubject(listing.id), definitions };
}

/**
 * Lo común, dentro del candado: el texto existe, es de este sujeto y es el **vigente** de su canal
 * e idioma. `CONTENT_NOT_FOUND` o `CONTENT_NOT_CURRENT`.
 */
async function currentContent(
  repos: Pick<SubjectLockedRepositories, "contents">,
  subject: Subject,
  contentId: string,
): Promise<Content> {
  const content = await repos.contents.get(contentId);
  if (content === null || !sameSubject(content.subject, subject)) throw contentNotFound(contentId);
  const current = (await repos.contents.listCurrent(subject)).find(
    (item) => item.platform === content.platform && item.language === content.language,
  );
  if (current?.id !== content.id) {
    throw new AppError(
      "CONTENT_NOT_CURRENT",
      `Ese texto ya no es el vigente: vuelve a cargar el contenido ${ofSubject(subject)}`,
      { details: { contentId, currentId: current?.id ?? null } },
    );
  }
  return content;
}

/**
 * Un texto vigente leído en el candado, con lo propio de su sujeto y los repositorios de **su**
 * candado (`repos`): con `kind` se elige el camino del aviso o del post sin volver a preguntar.
 */
export type LockedContent =
  | {
      kind: "listing";
      repos: LockedRepositories;
      content: Content;
      listing: Listing;
      /** La revisión editorial del aviso (`checkContent`, con su ficha y sus campos). */
      review: (content: Content) => CheckedContent;
    }
  | {
      kind: "post";
      repos: PostLockedRepositories;
      content: Content;
      post: Post;
      /** La revisión de un texto de post (spec F9 §4.4). */
      review: (content: Content) => CheckedContent;
    };

/**
 * La revisión de un texto de post. Las verificaciones de redes (`checkPostContent`, spec F9 §4.4:
 * largo, escape, menciones masivas, hechos fuera del perfil) llegan con F9-T11 y se conectan aquí;
 * hasta entonces no hay textos de posts (los crea `post.draft`, de T11).
 */
const reviewPostContent = (content: Content): CheckedContent => ({ content, checks: [] });

/**
 * Dentro del candado: el texto (que exista y sea el vigente de su canal e idioma) y lo propio de su
 * sujeto: en un aviso, el aviso y su revisión editorial (con las definiciones leídas antes); en un
 * post, el post. Lo comparten aprobar, quitar la aprobación y editar. `CONTENT_NOT_FOUND`,
 * `CONTENT_NOT_CURRENT`, `LISTING_NOT_FOUND`, `BROKER_NOT_FOUND` o `POST_NOT_FOUND`.
 */
export async function lockedCurrentContent(
  locked: LockedSubject,
  contentId: string,
  definitions: readonly FieldDefinition[],
): Promise<LockedContent> {
  const content = await currentContent(locked.repos, locked.subject, contentId);
  if (locked.kind === "listing") {
    const { listing, ctx } = await loadCheckContext(
      {
        listings: locked.repos.listings,
        brokers: locked.repos.brokers,
        fieldDefinitions: { list: async () => [...definitions] },
      },
      locked.subject.id,
    );
    return {
      kind: "listing",
      repos: locked.repos,
      content,
      listing,
      review: (item) => checked(item, ctx),
    };
  }
  const post = await locked.repos.posts.get(locked.subject.id);
  if (post === null) {
    throw new AppError("POST_NOT_FOUND", `No existe el post ${locked.subject.id}`, {
      details: { postId: locked.subject.id },
    });
  }
  return { kind: "post", repos: locked.repos, content, post, review: reviewPostContent };
}

/**
 * Deja el estado del post al día con sus textos (spec F9 §4.2): `ready` si tiene al menos un texto
 * vigente aprobado y `draft` si no. Una `idea` o un `archived` no cambian. Dentro del candado del
 * post, después de aprobar, quitar la aprobación o editar.
 */
export async function settlePostStatus(
  repos: Pick<PostLockedRepositories, "posts" | "contents">,
  post: Post,
): Promise<Post> {
  if (!canDraftPost(post.status)) return post;
  const approved = (await repos.contents.listCurrent(postSubject(post.id))).some(
    (content) => content.status === "approved",
  );
  const status = approved ? "ready" : "draft";
  return status === post.status ? post : repos.posts.update(post.id, { status });
}

export type { CheckedContent };
export { checked };
