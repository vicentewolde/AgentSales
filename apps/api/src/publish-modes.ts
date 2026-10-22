import {
  type BrokerRepository,
  brokerPublishMode,
  type ListingRepository,
  type PlatformAccountRepository,
  type PostRepository,
  type PublicationRepository,
  type PublishMode,
} from "@agentsales/core";

// El modo de cada pedido de la API (F9.5-T22, ADR-0036). El de una publicación sale del servidor
// (`PUBLISH_MODE`) **y** de su marca (`effectivePublishMode`, vía `brokerPublishMode`): nunca se
// compara `publishMode` con `"live"` en una ruta. Lo que no existe es simulación; el caso de uso
// responde después su propio «no existe».

/** Lo que hace falta para saber el modo de un pedido. `publishMode` es el del servidor. */
export type PublishModeDeps = {
  publishMode: PublishMode;
  brokers: Pick<BrokerRepository, "findById">;
};

/** El modo de la marca `brokerId`. */
export const brokerMode = (deps: PublishModeDeps, brokerId: string): Promise<PublishMode> =>
  brokerPublishMode(deps, deps.publishMode, brokerId);

/** El modo del corredor de un aviso. */
export async function listingMode(
  deps: PublishModeDeps & { listings: Pick<ListingRepository, "get"> },
  listingId: string,
): Promise<PublishMode> {
  const listing = await deps.listings.get(listingId);
  return listing === null ? "dry-run" : brokerMode(deps, listing.brokerId);
}

/** El modo de la marca de un post. */
export async function postMode(
  deps: PublishModeDeps & { posts: Pick<PostRepository, "get"> },
  postId: string,
): Promise<PublishMode> {
  const post = await deps.posts.get(postId);
  return post === null ? "dry-run" : brokerMode(deps, post.brokerId);
}

/** El modo de la marca dueña de la cuenta de una publicación (el corredor de su aviso o post). */
export async function publicationMode(
  deps: PublishModeDeps & {
    publications: Pick<PublicationRepository, "get">;
    platformAccounts: Pick<PlatformAccountRepository, "get">;
  },
  publicationId: string,
): Promise<PublishMode> {
  const publication = await deps.publications.get(publicationId);
  if (publication === null) return "dry-run";
  const account = await deps.platformAccounts.get(publication.platformAccountId);
  return account === null ? "dry-run" : brokerMode(deps, account.brokerId);
}

/** `dryRun` de un modo. */
export const isDryRun = (mode: PublishMode): boolean => mode !== "live";
