import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  LANGUAGES,
  type Language,
  type PostPlatform,
  SAME_NETWORK_MIN_GAP_MINUTES,
} from "@agentsales/core";
import { hasSomethingToPublish } from "../publications/publications.js";

// Qué textos del post salen al publicar o programar. Los idiomas de una red son el mismo post dicho
// dos veces: por defecto sale UNO por red (como el servidor, `defaultPostLanguages`), y el otro solo
// si el operador lo marca a conciencia.

/** Un texto aprobado con algo por publicar: una fila con casilla. */
export type PublishRow = { contentId: string; platform: PostPlatform; language: Language };

type RowContent = Pick<ContentView, "id" | "status" | "platform" | "language">;
type RowPublication = Pick<PublicationView, "contentId" | "status" | "platform" | "language">;

const active = new Set<string>(ACTIVE_PUBLICATION_STATUSES);

/**
 * Las filas de las redes dadas (en su orden), cada una con sus idiomas en el orden de `LANGUAGES`:
 * un texto aprobado sin publicaciones activas o con alguna aprobada o fallida. Sin las
 * publicaciones (cargando), todos los textos aprobados.
 */
export function publishRows(
  platforms: readonly PostPlatform[],
  contents: readonly RowContent[],
  publications: readonly RowPublication[] | undefined,
): PublishRow[] {
  const rows: PublishRow[] = [];
  for (const platform of platforms) {
    for (const language of LANGUAGES) {
      const content = contents.find(
        (item) =>
          item.platform === platform && item.language === language && item.status === "approved",
      );
      if (content === undefined) continue;
      if (
        publications !== undefined &&
        !hasSomethingToPublish(
          [content],
          publications.filter((publication) => publication.platform === platform),
        )
      ) {
        continue;
      }
      rows.push({ contentId: content.id, platform, language });
    }
  }
  return rows;
}

/**
 * Los textos marcados al empezar: el primero de cada red. Si la red ya tiene el otro idioma salido,
 * programado o saliendo, ninguno: el otro solo se marca a conciencia (igual que el servidor).
 */
export function defaultChosen(
  rows: readonly PublishRow[],
  contents: readonly RowContent[],
  publications: readonly RowPublication[] | undefined,
): string[] {
  const chosen: string[] = [];
  const done = new Set<string>();
  for (const row of rows) {
    if (done.has(row.platform)) continue;
    done.add(row.platform);
    const taken = (publications ?? []).some(
      (publication) =>
        publication.platform === row.platform &&
        active.has(publication.status) &&
        publication.status !== "approved" &&
        publication.status !== "failed" &&
        contents.some((c) => c.id === publication.contentId),
    );
    if (!taken) chosen.push(row.contentId);
  }
  return chosen;
}

/** Los idiomas marcados de cada red (solo las que tienen alguno). */
export function languagesByPlatform(
  rows: readonly PublishRow[],
  chosen: readonly string[],
): Map<PostPlatform, Language[]> {
  const byPlatform = new Map<PostPlatform, Language[]>();
  for (const row of rows) {
    if (!chosen.includes(row.contentId)) continue;
    byPlatform.set(row.platform, [...(byPlatform.get(row.platform) ?? []), row.language]);
  }
  return byPlatform;
}

/** Las redes con más de un idioma marcado: saldrían las dos a la vez. */
export const platformsWithSeveral = (
  rows: readonly PublishRow[],
  chosen: readonly string[],
): PostPlatform[] =>
  [...languagesByPlatform(rows, chosen)]
    .filter(([, languages]) => languages.length > 1)
    .map(([p]) => p);

/** Lo mínimo que separa dos idiomas de una red (el del servidor). */
export const MIN_SPACING_MINUTES = SAME_NETWORK_MIN_GAP_MINUTES;
/** El espacio que se propone. */
export const SUGGESTED_SPACING_MINUTES = 15;

/** La frase que explica por qué solo sale uno. */
export const ONE_PER_NETWORK_TEXT =
  "Son el mismo post en dos idiomas: sale uno; marca el otro si quieres publicarlo aparte.";
