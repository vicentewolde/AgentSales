import { AppError } from "../errors.js";
import { type PlatformCatalogEntry, platformCatalogEntrySchema } from "../platform-catalog.js";
import type { PlatformCatalogRepository } from "../ports/platform-catalog-repository.js";
import { structuredCopy } from "./copy.js";

export type InMemoryPlatformCatalogRepository = PlatformCatalogRepository & {
  /** Las claves guardadas de una plataforma, para revisar qué se bajó. */
  keys(platform?: PlatformCatalogEntry["platform"]): string[];
  /** Pisa `data` sin validar (una entrada guardada con una forma vieja). */
  corrupt(platform: PlatformCatalogEntry["platform"], key: string, data: unknown): void;
};

/** `PlatformCatalogRepository` en memoria (F4-T09): copia al guardar y al leer, como la base. */
export function createInMemoryPlatformCatalogRepository(): InMemoryPlatformCatalogRepository {
  const entries = new Map<string, PlatformCatalogEntry>();
  const id = (platform: string, key: string) => `${platform} ${key}`;
  return {
    async get(platform, key) {
      const entry = entries.get(id(platform, key));
      return entry === undefined ? null : structuredCopy(entry);
    },
    async put(entry) {
      const parsed = platformCatalogEntrySchema.safeParse(entry);
      if (!parsed.success) {
        throw new AppError("PLATFORM_CATALOG_ROW_INVALID", "La entrada del catálogo no es válida", {
          details: { platform: entry.platform, key: entry.key },
        });
      }
      entries.set(id(entry.platform, entry.key), structuredCopy(parsed.data));
    },
    keys(platform) {
      return [...entries.values()]
        .filter((entry) => platform === undefined || entry.platform === platform)
        .map((entry) => entry.key);
    },
    corrupt(platform, key, data) {
      const entry = entries.get(id(platform, key));
      if (entry !== undefined) {
        entries.set(id(platform, key), { ...entry, data: data as PlatformCatalogEntry["data"] });
      }
    },
  };
}
