import type { PublicationStatus } from "../enums.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import { postCardsInUse } from "../post-image.js";
import { postSubject } from "../subject.js";

// Quitar las tarjetas de un post (F9.5-T25, ADR-0038): qué medios son tarjetas, cuándo se pueden
// quitar y cómo se borran sus archivos. Lo usan la API (`removePostCards`) y el worker (el
// reemplazo de un pedido de tarjetas con `replaceCards`, que borra solo cuando las nuevas ya están).

/** Cuántos pedidos de un post se leen para saber cuáles de sus medios son tarjetas. */
const ALL_RUNS = 500;

/**
 * Las publicaciones en estos estados usan (o usaron) los medios del post: no se les quitan imágenes.
 * `failed`, `cancelled` y `unpublished` no los usan: no bloquean (ADR-0038).
 */
export const CARD_MEDIA_KEPT_BY: ReadonlySet<PublicationStatus> = new Set<PublicationStatus>([
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "published",
  "paused",
  "outcome_unknown",
]);

/** `POST_CARDS_IN_USE` si alguna publicación del post usa sus medios. */
export function assertCardsRemovable(
  publications: readonly { status: PublicationStatus }[],
  postId: string,
): void {
  if (publications.some((publication) => CARD_MEDIA_KEPT_BY.has(publication.status))) {
    throw postCardsInUse(postId);
  }
}

/**
 * Los ids de los medios del post que son tarjetas: los de sus pedidos de tarjetas terminados que
 * siguen siendo originales del post. Lo que el usuario subió, una foto de la biblioteca o una imagen
 * con IA nunca está aquí (el post no guarda de dónde salió un medio: lo dicen los pedidos).
 */
export async function cardMediaIds(
  deps: {
    runs: Pick<PostImageRunRepository, "listByPost">;
    media: Pick<MediaRepository, "listBySubject">;
  },
  postId: string,
): Promise<string[]> {
  const runs = await deps.runs.listByPost(postId, ALL_RUNS);
  const fromCards = new Set(
    runs
      .filter((run) => run.source === "card" && run.status === "succeeded")
      .flatMap((run) => run.mediaIds),
  );
  if (fromCards.size === 0) return [];
  const all = await deps.media.listBySubject(postSubject(postId));
  return all.filter((item) => item.role === "original" && fromCards.has(item.id)).map((i) => i.id);
}

/**
 * Borra archivos de R2 uno por uno. Un archivo que no se pudo borrar queda suelto en el bucket sin
 * afectar al post: se devuelve su clave (sin URL ni firma) para contarlo o registrarlo.
 */
export async function deleteStoredFiles(
  storage: Pick<MediaStorage, "delete">,
  paths: readonly string[],
): Promise<string[]> {
  const results = await Promise.allSettled(paths.map((path) => storage.delete(path)));
  return paths.filter((_, index) => results[index]?.status === "rejected");
}
