import type { BrandCardStyle } from "../card-style.js";
import type { CardStyleRepository } from "../ports/card-style-repository.js";
import { structuredCopy } from "./copy.js";

export type InMemoryCardStyleRepository = CardStyleRepository & {
  /** El tema fijado de cada post. */
  themes: Map<string, { brokerId: string; theme: number }>;
};

/** `CardStyleRepository` en memoria, con la semántica del de Drizzle. */
export function createInMemoryCardStyleRepository(): InMemoryCardStyleRepository {
  const styles = new Map<string, BrandCardStyle>();
  const themes = new Map<string, { brokerId: string; theme: number }>();
  return {
    themes,
    async get(brokerId) {
      const found = styles.get(brokerId);
      return found === undefined ? null : structuredCopy(found);
    },
    async save(brokerId, style) {
      const saved: BrandCardStyle = {
        brokerId,
        style: structuredCopy(style),
        version: (styles.get(brokerId)?.version ?? 0) + 1,
        updatedAt: new Date(),
      };
      styles.set(brokerId, saved);
      return structuredCopy(saved);
    },
    async assignTheme(postId, brokerId, count) {
      const current = themes.get(postId);
      if (current !== undefined) return current.theme;
      const used = [...themes.values()].filter((item) => item.brokerId === brokerId).length;
      const theme = count <= 0 ? 0 : used % count;
      themes.set(postId, { brokerId, theme });
      return theme;
    },
  };
}
