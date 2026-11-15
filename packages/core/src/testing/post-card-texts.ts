import type { PostCardTextRepository } from "../ports/post-card-text-repository.js";
import type { PostCardText } from "../post-card-texts.js";
import { structuredCopy } from "./copy.js";

/** `PostCardTextRepository` en memoria, con la semántica del de Drizzle. */
export function createInMemoryPostCardTextRepository(): PostCardTextRepository {
  let rows: PostCardText[] = [];
  return {
    async list(postId) {
      return rows
        .filter((row) => row.postId === postId)
        .sort((a, b) => a.language.localeCompare(b.language) || a.position - b.position)
        .map(structuredCopy);
    },
    async replace(postId, language, texts, { fromAi }) {
      const mine = rows.filter((row) => row.postId === postId && row.language === language);
      if (fromAi && mine.some((row) => row.approved)) return false;
      rows = rows.filter((row) => !(row.postId === postId && row.language === language));
      const now = new Date();
      texts.forEach((text, index) => {
        rows.push({
          postId,
          language,
          position: index + 1,
          ...text,
          approved: !fromAi,
          updatedAt: now,
        });
      });
      return true;
    },
  };
}
