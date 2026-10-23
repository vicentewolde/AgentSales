import {
  type BrokerRepository,
  brokerPublishMode,
  type ListingRepository,
  listingPublishMode,
  type PlatformAccountRepository,
  type PostRepository,
  type PublicationRepository,
  type PublishMode,
  postPublishMode,
  publicationPublishMode,
} from "@agentsales/core";

// El modo de cada pedido de la API (F9.5-T22, ADR-0036): adaptadores delgados sobre las funciones
// de core (`listingPublishMode`, `postPublishMode`, `publicationPublishMode`), que combinan el modo
// del servidor (`PUBLISH_MODE`, aquí `deps.publishMode`) con la marca del sujeto. Nunca se compara
// `publishMode` con `"live"` en una ruta.

/** Lo que hace falta para saber el modo de un pedido. `publishMode` es el del servidor. */
export type PublishModeDeps = {
  publishMode: PublishMode;
  brokers: Pick<BrokerRepository, "findById">;
};

/** El modo de la marca `brokerId`. */
export const brokerMode = (deps: PublishModeDeps, brokerId: string): Promise<PublishMode> =>
  brokerPublishMode(deps, deps.publishMode, brokerId);

/** El modo del corredor de un aviso. */
export const listingMode = (
  deps: PublishModeDeps & { listings: Pick<ListingRepository, "get"> },
  listingId: string,
): Promise<PublishMode> => listingPublishMode(deps, deps.publishMode, listingId);

/** El modo de la marca de un post. */
export const postMode = (
  deps: PublishModeDeps & { posts: Pick<PostRepository, "get"> },
  postId: string,
): Promise<PublishMode> => postPublishMode(deps, deps.publishMode, postId);

/** El modo de la marca dueña de la cuenta de una publicación (la del sujeto). */
export const publicationMode = (
  deps: PublishModeDeps & {
    publications: Pick<PublicationRepository, "get">;
    platformAccounts: Pick<PlatformAccountRepository, "get">;
  },
  publicationId: string,
): Promise<PublishMode> => publicationPublishMode(deps, deps.publishMode, publicationId);

/** `dryRun` de un modo ya efectivo (nunca el del servidor: el test guardián lo revisa). */
export const isDryRun = (mode: PublishMode): boolean => mode !== "live";
