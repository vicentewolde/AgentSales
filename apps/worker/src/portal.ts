import type { Logger } from "@agentsales/config";
import type {
  MediaStorage,
  Platform,
  PlatformCatalogRepository,
  PublicationOperations,
  Publisher,
  PublishMediaItem,
} from "@agentsales/core";
import {
  createMercadoLibreCatalogApi,
  createMercadoLibreItems,
  createMercadoLibrePictures,
  createMercadoLibreValidator,
  createPortalCatalog,
  createPortalOperations,
  createPortalPublisher,
  type MercadoLibreItems,
  type MercadoLibrePictures,
  type MercadoLibreValidator,
} from "@agentsales/publishers";

/** Lo que el worker usa de Portal: el publisher y las operaciones para el sync. */
export type WorkerPortal = {
  /**
   * Registrado en los dos modos, como el de Instagram: una publicación en `dry_run` también lo
   * necesita (lo envuelve `withDryRun`, que solo llama a `preflight`).
   */
  publisher: Publisher;
  /**
   * Las operaciones por plataforma para el sync (`syncPublication`), **sin envolver**: el sync
   * solo lee, así que una publicación `live` se sincroniza aunque el worker esté en `dry-run`
   * (`withDryRun` no expone `getStatus`).
   */
  operationsFor(platform: Platform): PublicationOperations | undefined;
};

export type WorkerPortalDeps = {
  /** El catálogo de Mercado Libre guardado en la base (7 días de vida, ADR-0015). */
  catalogRepository: PlatformCatalogRepository;
  /** Las fotos fijadas en la publicación se leen de R2 y se suben a Mercado Libre (D4). */
  storage: Pick<MediaStorage, "get">;
  logger: Logger;
  /** Los clientes de Mercado Libre; por defecto, los reales (los tests pasan los suyos). */
  clients?: {
    items?: MercadoLibreItems;
    pictures?: MercadoLibrePictures;
    validator?: MercadoLibreValidator;
  };
};

/**
 * Los bytes de una foto fijada en la publicación (la variante `pi_4x3`, JPEG), leídos de R2. Un
 * error de R2 sube tal cual: si es pasajero, el reintento retoma desde la foto que faltaba.
 */
export const readPictureFrom =
  (storage: Pick<MediaStorage, "get">) =>
  (media: PublishMediaItem): Promise<Uint8Array> =>
    storage.get(media.storagePath);

/**
 * Arma Portal para el worker (spec F4 §4.8 y F4-T18): el publisher con el catálogo (y su caché en
 * la base), el validador (para `preflight`), las fotos desde R2 y el cliente de ítems, y las
 * operaciones con ese mismo cliente. El token lo arma el intento o el sync con `ensureAccessToken`.
 * Las notas del catálogo (una copia vencida usada, una que no se pudo guardar) van al log con su
 * código, sin datos del aviso.
 */
export function createWorkerPortal(deps: WorkerPortalDeps): WorkerPortal {
  const items = deps.clients?.items ?? createMercadoLibreItems();
  const catalog = createPortalCatalog({
    api: createMercadoLibreCatalogApi(),
    repository: deps.catalogRepository,
    onNote: (note) => deps.logger.warn(note, "nota del catálogo de Mercado Libre"),
  });
  const publisher = createPortalPublisher({
    items,
    pictures: deps.clients?.pictures ?? createMercadoLibrePictures(),
    validator: deps.clients?.validator ?? createMercadoLibreValidator(),
    catalog,
    readPicture: readPictureFrom(deps.storage),
  });
  const operations = createPortalOperations({ items });
  return {
    publisher,
    operationsFor: (platform) => (platform === "portal_inmobiliario" ? operations : undefined),
  };
}
