import type { Language, PublicationStatus } from "../enums.js";
import { AppError } from "../errors.js";
import type { MediaRecord } from "../ports/media-repository.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository } from "../ports/post-repository.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";
import { assertPostAccess, postNotFound } from "./posts.js";

// Marcar el idioma de una foto o un video de un post (ADR-0042): `PATCH /posts/:id/media/:mediaId`
// y `post media-language`. Qué lleva cada texto con esa marca lo decide `mediaForText`.

type Actor = Pick<User, "id" | "role" | "brokerId">;

/**
 * Las publicaciones en estos estados ya fijaron sus medios (`media_ids`, al abrirse) y todavía los
 * van a usar: cambiar el idioma de una imagen no las cambiaría, así que se niega. Una publicada ya
 * salió y una cancelada o retirada no se usa: no impiden marcar.
 */
export const MEDIA_LANGUAGE_LOCKED_BY: ReadonlySet<PublicationStatus> = new Set<PublicationStatus>([
  "approved",
  "scheduled",
  "publishing",
  "failed",
  "awaiting_manual_confirm",
  "paused",
  "outcome_unknown",
]);

export type SetPostMediaLanguageDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
};

/**
 * Fija el idioma de un original del post (`null`: sirve para todos los idiomas) y lo devuelve.
 * Errores: `POST_NOT_FOUND` (404, también lo ajeno), `POST_ARCHIVED` (409), `MEDIA_NOT_FOUND` (404:
 * el id no es un original de ese post) y `POST_MEDIA_IN_USE` (409: alguna publicación del post ya
 * fijó sus medios; se quita la aprobación de ese texto, se marca y se aprueba de nuevo).
 */
export async function setPostMediaLanguage(
  deps: SetPostMediaLanguageDeps,
  actor: Actor,
  postId: string,
  mediaId: string,
  language: Language | null,
): Promise<MediaRecord> {
  assertPostAccess(actor, await deps.posts.get(postId), postId);
  return deps.postLock.run(postId, async ({ posts, media, publications }) => {
    const post = await posts.get(postId);
    if (post === null) throw postNotFound(postId);
    if (post.status === "archived") {
      throw new AppError("POST_ARCHIVED", "El post está archivado: sus medios ya no cambian", {
        details: { postId },
      });
    }
    const subject = postSubject(postId);
    const original = (await media.listOriginals(subject)).find((item) => item.id === mediaId);
    if (original === undefined) {
      throw new AppError("MEDIA_NOT_FOUND", "Ese medio no es una foto ni un video de este post", {
        details: { postId, mediaId },
      });
    }
    if ((original.language ?? null) === language) return original;
    const locked = (await publications.listBySubject(subject)).find((publication) =>
      MEDIA_LANGUAGE_LOCKED_BY.has(publication.status),
    );
    if (locked !== undefined) {
      throw new AppError(
        "POST_MEDIA_IN_USE",
        "Este post tiene publicaciones con sus imágenes ya fijadas (aprobadas, programadas o pendientes): quita la aprobación de esos textos (o descarta las fallidas), cambia el idioma y vuelve a aprobar",
        { details: { postId, mediaId, publicationId: locked.id, status: locked.status } },
      );
    }
    const updated = await media.setLanguage(subject, mediaId, language);
    if (updated === null) {
      throw new AppError("MEDIA_NOT_FOUND", "Ese medio no es una foto ni un video de este post", {
        details: { postId, mediaId },
      });
    }
    return updated;
  });
}
