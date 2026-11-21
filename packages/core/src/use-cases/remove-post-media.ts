import type { PublicationStatus } from "../enums.js";
import { AppError } from "../errors.js";
import { LANGUAGE_TEXT, PLATFORM_TEXT, PUBLICATION_STATUS_TEXT } from "../labels.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";
import { deleteStoredFiles } from "./post-cards-cleanup.js";
import { assertPostAccess, postNotFound } from "./posts.js";

// Quitar una foto o un video de un post (2026-11-21): `DELETE /posts/:id/media/:mediaId` y
// `post media remove`. Se borra de verdad (la fila, sus variantes y sus archivos de R2), como las
// tarjetas (`removePostCards`), pero solo después de la confirmación del panel o de la CLI: un medio
// oculto tendría que filtrarse en cada lectura y publicación, y no dejaría volver a subir el mismo
// archivo (`media_original_post_checksum_unique`).

type Actor = Pick<User, "id" | "role" | "brokerId">;

/**
 * Las publicaciones en estos estados ya salieron, están saliendo o van a salir solas con sus medios
 * fijados: si usan el medio, no se quita. Una `approved` o `failed` todavía no salió (se le quita
 * de sus `media_ids`) y una `cancelled` o `unpublished` ya no se usa (queda como historia).
 */
export const MEDIA_REMOVAL_BLOCKED_BY: ReadonlySet<PublicationStatus> = new Set<PublicationStatus>([
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "paused",
  "outcome_unknown",
]);

/** Las que todavía no salieron: pierden el medio de sus `media_ids`. */
export const MEDIA_REMOVAL_UPDATES: readonly PublicationStatus[] = ["approved", "failed"];

/** Qué hacer con una publicación que impide quitar el medio, según su estado. */
const WHAT_TO_DO: Readonly<Partial<Record<PublicationStatus, string>>> = {
  scheduled: "desprográmala o descártala y vuelve a quitarlo",
  publishing: "espera a que termine de publicarse",
  awaiting_manual_confirm:
    "confirma si la publicaste o márcala como no publicada, y vuelve a quitarlo",
  published: "ya salió con este medio: retírala primero si quieres quitarlo",
  paused: "ya salió con este medio: retírala primero si quieres quitarlo",
  outcome_unknown: "di si salió o no (resolver) y, si no salió, vuelve a quitarlo",
};

export type RemovePostMediaDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "delete">;
};

export type RemovePostMediaResult = {
  /** El id del medio quitado. */
  mediaId: string;
  /** Las publicaciones aprobadas o fallidas que lo tenían y ya no lo llevan. */
  updatedPublicationIds: string[];
  /** Los archivos de R2 que no se pudieron borrar (quedan sueltos en el bucket; el post no cambia). */
  leftover: number;
};

const mediaNotFound = (postId: string, mediaId: string) =>
  new AppError("MEDIA_NOT_FOUND", "Ese medio no es una foto ni un video de este post", {
    details: { postId, mediaId },
  });

/** `POST_MEDIA_IN_USE` con la publicación que lo impide y qué hacer. */
function mediaInUse(postId: string, mediaId: string, publication: Publication): AppError {
  const where = `${PLATFORM_TEXT[publication.platform]} en ${LANGUAGE_TEXT[publication.language]}`;
  return new AppError(
    "POST_MEDIA_IN_USE",
    `No se puede quitar: la publicación de ${where} (${PUBLICATION_STATUS_TEXT[publication.status]}) usa este medio; ${WHAT_TO_DO[publication.status] ?? "revísala primero"}`,
    {
      details: {
        postId,
        mediaId,
        publicationId: publication.id,
        platform: publication.platform,
        language: publication.language,
        status: publication.status,
      },
    },
  );
}

/**
 * Quita un original del post con sus variantes. En el candado del post: `POST_ARCHIVED` (409) en un
 * post archivado, `MEDIA_NOT_FOUND` (404) si el id no es un original de ese post y
 * `POST_MEDIA_IN_USE` (409) si una publicación programada, publicándose, esperando el clic,
 * publicada, pausada o con resultado dudoso lo usa (el mensaje dice cuál y qué hacer). A las
 * aprobadas y fallidas que lo usan se les quita de `media_ids` (con un `manual_edit`). Después del
 * candado, borra los archivos de R2; si uno falla, queda suelto y se cuenta en `leftover`.
 */
export async function removePostMedia(
  deps: RemovePostMediaDeps,
  actor: Actor,
  postId: string,
  mediaId: string,
  options: { eventActor?: PublicationActor } = {},
): Promise<RemovePostMediaResult> {
  assertPostAccess(actor, await deps.posts.get(postId), postId);
  const { paths, updatedPublicationIds } = await deps.postLock.run(
    postId,
    async ({ posts, media, publications }) => {
      const post = await posts.get(postId);
      if (post === null) throw postNotFound(postId);
      if (post.status === "archived") {
        throw new AppError("POST_ARCHIVED", "El post está archivado: sus medios ya no cambian", {
          details: { postId },
        });
      }
      const subject = postSubject(postId);
      const original = (await media.listOriginals(subject)).find((item) => item.id === mediaId);
      if (original === undefined) throw mediaNotFound(postId, mediaId);
      // Las publicaciones fijan el original o sus variantes (`ig_4x5`, `post_full`, `ig_reel`…).
      const own = new Set([
        mediaId,
        ...(await media.listBySubject(subject))
          .filter((item) => item.parentMediaId === mediaId)
          .map((item) => item.id),
      ]);
      const using = (await publications.listBySubject(subject)).filter((publication) =>
        publication.mediaIds.some((id) => own.has(id)),
      );
      const blocking = using.find((publication) =>
        MEDIA_REMOVAL_BLOCKED_BY.has(publication.status),
      );
      if (blocking !== undefined) throw mediaInUse(postId, mediaId, blocking);
      const updated: string[] = [];
      for (const publication of using) {
        if (!MEDIA_REMOVAL_UPDATES.includes(publication.status)) continue;
        await publications.removeMediaIds(
          publication.id,
          { statuses: MEDIA_REMOVAL_UPDATES, mediaIds: [...own] },
          {
            actor: options.eventActor ?? "operator",
            userId: actor.id,
            payload: { mediaRemoved: publication.mediaIds.filter((id) => own.has(id)) },
          },
        );
        updated.push(publication.id);
      }
      const deleted = await media.deleteOriginals(subject, [mediaId]);
      if (deleted.length === 0) throw mediaNotFound(postId, mediaId);
      return { paths: deleted, updatedPublicationIds: updated };
    },
  );
  const leftover = await deleteStoredFiles(deps.storage, paths);
  return { mediaId, updatedPublicationIds, leftover: leftover.length };
}
