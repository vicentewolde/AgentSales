import { type MediaRepository, type MediaStorage, postSubject } from "@agentsales/core";
import type { PostCover } from "../contracts/index.js";

/**
 * La portada de cada post de una lista (miniatura firmada del primer medio, la marcada como portada
 * primero) para mirar las listas con imágenes (Contenido y Plan); los posts sin medios no aparecen.
 */
export async function postCovers(
  deps: {
    media: Pick<MediaRepository, "listBySubject">;
    storage: Pick<MediaStorage, "signedReadUrl">;
  },
  postIds: readonly string[],
): Promise<Record<string, PostCover>> {
  const entries = await Promise.all(
    postIds.map(async (postId) => {
      const all = await deps.media.listBySubject(postSubject(postId));
      const originals = all
        .filter((item) => item.role === "original")
        .sort(
          (a, b) =>
            Number(b.isCover) - Number(a.isCover) ||
            a.sortOrder - b.sortOrder ||
            a.id.localeCompare(b.id),
        );
      const first = originals[0];
      if (first === undefined) return null;
      const thumb = all.find(
        (item) =>
          item.role === "processed" && item.parentMediaId === first.id && item.variant === "thumb",
      );
      const cover: PostCover = {
        url: await deps.storage.signedReadUrl((thumb ?? first).storagePath),
        kind: first.kind,
        count: originals.length,
      };
      return [postId, cover] as const;
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}
