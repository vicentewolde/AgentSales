import { normalizeHashtags } from "../content/assemble.js";
import {
  beforeContentLock,
  type CheckedContent,
  type ContentLockDeps,
  lockedCurrentContent,
  settlePostStatus,
} from "../content/locked-content.js";
import { AppError } from "../errors.js";
import type { ContentChanges } from "../ports/content-repository.js";
import { ACTIVE_PUBLICATION_STATUSES, PENDING_PUBLICATION_STATUSES } from "../publication-state.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";

export type EditContentDeps = ContentLockDeps & SubjectLocks;

/** Lo que el operador puede cambiar de un texto; `undefined` = no tocar. */
export type ContentEdit = { title?: string; body?: string; hashtags?: string[] };

/**
 * Edita el texto **vigente** de un canal (spec F2 §4.6 y F3 §4.2, `PATCH /contents/:id`) y lo deja
 * en `edited`, dentro del candado de su sujeto (el del aviso o, desde F9, el del post, ADR-0029):
 * un pedido de textos y una edición ya no se cruzan (la ventana de F2 se cerró). Errores
 * (`AppError`):
 * - el texto o su aviso o post no existen → `CONTENT_NOT_FOUND`, `LISTING_NOT_FOUND` o
 *   `POST_NOT_FOUND` (404);
 * - no es el vigente de su canal (e idioma) → `CONTENT_NOT_CURRENT` (409);
 * - hay una corrida activa que genera textos → `CONTENT_RUN_ACTIVE` (409): la reemplazaría sin
 *   avisar (una de solo imágenes no toca los textos, así que sí se puede);
 * - el texto tiene una publicación activa (pendiente o `published`) → `CONTENT_LOCKED` (409): es el
 *   registro de lo que se aprobó o se publicó (ADR-0014). Uno aprobado sin publicaciones activas sí
 *   se edita y pierde la aprobación (vuelve a `edited`; un post sin otro texto aprobado vuelve a
 *   `draft`);
 * - un título en Instagram o en un post, que no lo tienen → `CONTENT_TITLE_INVALID` (400);
 * - hashtags en Portal o Marketplace, que no los usan → `CONTENT_HASHTAGS_INVALID` (400). Los textos
 *   de un post llevan hashtags en todas sus redes (spec F9 §4.4: en LinkedIn y X van dentro del
 *   texto al enviarlo).
 * Los hashtags se normalizan y se descartan los vacíos y repetidos. El largo y lo demás no se
 * rechaza: lo informa la revisión que vuelve con el texto.
 */
export async function editContent(
  deps: EditContentDeps,
  { contentId, edit }: { contentId: string; edit: ContentEdit },
): Promise<CheckedContent> {
  const { subject, definitions } = await beforeContentLock(deps, contentId);

  return runOnSubject(deps, subject, async (locked) => {
    const found = await lockedCurrentContent(locked, contentId, definitions);
    const { repos, content } = found;
    const active = await repos.contentRuns.findActive(content.subject);
    if (active?.texts) {
      throw new AppError(
        "CONTENT_RUN_ACTIVE",
        "Hay una preparación de textos en curso: espera a que termine para editar",
        { details: { contentId, contentRunId: active.id } },
      );
    }
    const publication = (await repos.publications.listBySubject(content.subject)).find(
      (item) => item.contentId === content.id && ACTIVE_PUBLICATION_STATUSES.includes(item.status),
    );
    if (publication !== undefined) {
      // Qué hacer depende de la publicación: una que no salió se descarta o se le quita la
      // aprobación al texto; una publicada se marca como retirada (en Instagram, tras borrarla a mano).
      const pending = (PENDING_PUBLICATION_STATUSES as readonly string[]).includes(
        publication.status,
      );
      throw new AppError(
        "CONTENT_LOCKED",
        pending
          ? "Este texto tiene una publicación aprobada que no ha salido: quita la aprobación o descarta la publicación para editarlo"
          : "Este texto ya está publicado: para cambiarlo, retira la publicación y prepara un texto nuevo",
        { details: { contentId, publicationId: publication.id, status: publication.status } },
      );
    }

    const changes: ContentChanges = { status: "edited" };
    if (edit.title !== undefined) {
      if (found.kind === "post") {
        throw new AppError("CONTENT_TITLE_INVALID", "Los textos de un post no tienen título");
      }
      if (content.platform === "instagram") {
        throw new AppError("CONTENT_TITLE_INVALID", "Instagram no tiene título");
      }
      changes.title = edit.title;
    }
    if (edit.body !== undefined) changes.body = edit.body;
    if (edit.hashtags !== undefined) {
      if (
        found.kind === "listing" &&
        content.platform !== "instagram" &&
        edit.hashtags.length > 0
      ) {
        throw new AppError(
          "CONTENT_HASHTAGS_INVALID",
          "Solo Instagram usa hashtags: en este canal deben ir vacíos",
        );
      }
      changes.hashtags = normalizeHashtags(edit.hashtags);
    }

    const updated = await repos.contents.update(content.id, changes);
    if (found.kind === "post" && content.status === "approved") {
      await settlePostStatus(found.repos, found.post);
    }
    return found.review(updated);
  });
}
