import { normalizeHashtag } from "../content/assemble.js";
import {
  type CheckedContent,
  type ContentCheckDeps,
  checked,
  loadCheckContext,
} from "../content/check-context.js";
import { AppError } from "../errors.js";
import type {
  ContentChanges,
  ContentRepository,
  ContentRunRepository,
} from "../ports/content-repository.js";

export type EditContentDeps = ContentCheckDeps & {
  contents: Pick<ContentRepository, "get" | "listCurrent" | "update">;
  contentRuns: Pick<ContentRunRepository, "findActive">;
};

/** Lo que el operador puede cambiar de un texto; `undefined` = no tocar. */
export type ContentEdit = { title?: string; body?: string; hashtags?: string[] };

/** Hashtags de Instagram normalizados, sin vacíos ni repetidos (spec F2 §4.6). */
function instagramHashtags(tags: readonly string[]): string[] {
  const normalized = tags.map(normalizeHashtag).filter((tag): tag is string => tag !== null);
  return [...new Set(normalized)];
}

/**
 * Edita el texto **vigente** de un canal (spec F2 §4.6, `PATCH /contents/:id`) y lo deja en
 * `edited`. Errores (`AppError`):
 * - el texto no existe → `CONTENT_NOT_FOUND` (404);
 * - no es el vigente de su canal → `CONTENT_NOT_CURRENT` (409);
 * - el aviso tiene una corrida activa que genera textos → `CONTENT_RUN_ACTIVE` (409): la reemplazaría
 *   sin avisar (una de solo imágenes no toca los textos, así que sí se puede);
 * - un título en Instagram, que no lo tiene → `CONTENT_TITLE_INVALID` (400);
 * - hashtags en Portal o Marketplace, que no los usan → `CONTENT_HASHTAGS_INVALID` (400).
 * En Instagram, los hashtags se normalizan y se descartan los vacíos y repetidos. El largo y lo
 * demás no se rechaza: lo informa la revisión que vuelve con el texto.
 * Entre revisar la corrida activa y guardar puede colarse un pedido de textos: la edición se guarda
 * y esa corrida la reemplazará. La ventana es mínima, y el pedido ya avisa con `CONTENT_EDITED` si
 * la edición llegó antes.
 */
export async function editContent(
  deps: EditContentDeps,
  { contentId, edit }: { contentId: string; edit: ContentEdit },
): Promise<CheckedContent> {
  const content = await deps.contents.get(contentId);
  if (content === null) {
    throw new AppError("CONTENT_NOT_FOUND", `No existe el texto ${contentId}`, {
      details: { contentId },
    });
  }
  const current = (await deps.contents.listCurrent(content.listingId)).find(
    (item) => item.platform === content.platform,
  );
  if (current?.id !== content.id) {
    throw new AppError(
      "CONTENT_NOT_CURRENT",
      "Ese texto ya no es el vigente: vuelve a cargar el contenido del aviso",
      { details: { contentId, currentId: current?.id ?? null } },
    );
  }
  const active = await deps.contentRuns.findActive(content.listingId);
  if (active?.texts) {
    throw new AppError(
      "CONTENT_RUN_ACTIVE",
      "Hay una preparación de textos en curso: espera a que termine para editar",
      { details: { contentId, contentRunId: active.id } },
    );
  }

  // El contexto antes de guardar: si falta el aviso o el corredor, no queda una edición guardada
  // con una respuesta de error.
  const { ctx } = await loadCheckContext(deps, content.listingId);
  const changes: ContentChanges = { status: "edited" };
  if (edit.title !== undefined) {
    if (content.platform === "instagram") {
      throw new AppError("CONTENT_TITLE_INVALID", "Instagram no tiene título");
    }
    changes.title = edit.title;
  }
  if (edit.body !== undefined) changes.body = edit.body;
  if (edit.hashtags !== undefined) {
    if (content.platform !== "instagram" && edit.hashtags.length > 0) {
      throw new AppError(
        "CONTENT_HASHTAGS_INVALID",
        "Solo Instagram usa hashtags: en este canal deben ir vacíos",
      );
    }
    changes.hashtags = instagramHashtags(edit.hashtags);
  }

  return checked(await deps.contents.update(content.id, changes), ctx);
}
