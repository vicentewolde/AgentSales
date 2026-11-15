import type { Language } from "../enums.js";
import { AppError } from "../errors.js";
import { buildImagePdf, jpegSize } from "../image-pdf.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { PostImageRunRepository } from "../ports/post-image-run-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import { hiddenCardIds, loadCardLanguages } from "../post-card-languages.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";
import { assertPostAccess } from "./posts.js";

// «Descargar PDF para LinkedIn» (spec F9.7 B7, ADR-0043 punto 7): las imágenes de un carrusel, en
// su orden y las de **un** idioma (las tarjetas de otro idioma no van; lo que subió el usuario sin
// idioma, sí), unidas en un PDF. LinkedIn lo muestra como carrusel.

type Actor = Pick<User, "id" | "role" | "brokerId">;

export type PostLinkedInPdfDeps = {
  posts: Pick<PostRepository, "get">;
  media: Pick<MediaRepository, "listOriginals">;
  storage: Pick<MediaStorage, "get">;
  postImageRuns?: Pick<PostImageRunRepository, "listByPost">;
};

/** Cuántas páginas como mucho (LinkedIn acepta documentos de hasta 300 páginas; un carrusel, 20). */
export const LINKEDIN_PDF_MAX_PAGES = 20;

/**
 * El PDF de las imágenes del post en `language` (`posts.manage`). Solo JPEG (las tarjetas y las
 * fotos subidas en JPEG); un post sin imágenes JPEG de ese idioma es `POST_PDF_NO_IMAGES` (409).
 */
export async function postLinkedInPdf(
  deps: PostLinkedInPdfDeps,
  actor: Actor,
  postId: string,
  language: Language,
): Promise<{ pdf: Uint8Array; pages: number; skipped: number }> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  const originals = (await deps.media.listOriginals(postSubject(post.id)))
    .filter((item) => item.kind === "image")
    .filter((item) => item.language == null || item.language === language)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const cards = await loadCardLanguages(deps.postImageRuns, post.id);
  const hidden = hiddenCardIds(
    originals.map((item) => item.id),
    cards,
    language,
  );
  const chosen = originals.filter((item) => !hidden.has(item.id)).slice(0, LINKEDIN_PDF_MAX_PAGES);
  const jpegs: Uint8Array[] = [];
  let skipped = 0;
  for (const item of chosen) {
    const bytes = await deps.storage.get(item.storagePath);
    if (jpegSize(bytes) === null) skipped += 1;
    else jpegs.push(bytes);
  }
  if (jpegs.length === 0) {
    throw new AppError(
      "POST_PDF_NO_IMAGES",
      "El post no tiene imágenes JPEG de ese idioma para el PDF: haz las tarjetas de la marca",
      { details: { postId, language } },
    );
  }
  return { pdf: buildImagePdf(jpegs, post.topic), pages: jpegs.length, skipped };
}
