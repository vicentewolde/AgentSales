import type { Broker } from "./broker.js";
import type { PublishMode } from "./enums.js";
import { AppError } from "./errors.js";
import type { PlatformAccount } from "./platform-account.js";
import type { BrokerRepository } from "./ports/broker-repository.js";
import type { ListingRepository } from "./ports/listing-repository.js";
import type { PlatformAccountRepository } from "./ports/platform-account-repository.js";
import type { PostRepository } from "./ports/post-repository.js";
import type { PublicationRepository } from "./ports/publication-repository.js";

/**
 * Lo que `effectivePublishMode` mira de un corredor o una marca: las dos condiciones de la segunda
 * llave (ADR-0036).
 */
export type PublishModeBroker = Pick<Broker, "liveEnabled" | "operatorOwned">;

/**
 * Si la marca tiene abierta su llave del modo en vivo (ADR-0036): encendida (`live_enabled`) **y**
 * propia del operador (`operator_owned`). No mira el servidor.
 */
export const brokerLiveEnabled = (broker: PublishModeBroker): boolean =>
  broker.liveEnabled && broker.operatorOwned;

/**
 * **La única fuente del modo de una publicación** (F9.5-T22, ADR-0036): sale de verdad (`live`)
 * solo si el servidor está en `PUBLISH_MODE=live` **y** la marca tiene `live_enabled` **y** es propia
 * del operador (`operator_owned`). Con cualquiera de las tres cosas apagada, es `dry-run`.
 *
 * Nada más en core, la API ni el worker decide el modo de una publicación a partir de
 * `PUBLISH_MODE`: un test recorre el código fuente y falla si encuentra otra lectura.
 */
export function effectivePublishMode(
  serverMode: PublishMode,
  broker: PublishModeBroker,
): PublishMode {
  return serverMode === "live" && brokerLiveEnabled(broker) ? "live" : "dry-run";
}

/** `effectivePublishMode(...) === "dry-run"`: el `dryRun` que se fija en una publicación. */
export const effectiveDryRun = (serverMode: PublishMode, broker: PublishModeBroker): boolean =>
  effectivePublishMode(serverMode, broker) === "dry-run";

type BrokerDeps = { brokers: Pick<BrokerRepository, "findById"> };

/**
 * El modo del corredor `brokerId` (por id). Un corredor que no existe es `dry-run`: ante la duda,
 * simulación.
 */
export async function brokerPublishMode(
  deps: BrokerDeps,
  serverMode: PublishMode,
  brokerId: string,
): Promise<PublishMode> {
  // Sin el servidor en `live` ninguna marca publica de verdad: ni se busca.
  if (serverMode !== "live") return "dry-run";
  const broker = await deps.brokers.findById(brokerId);
  return broker === null ? "dry-run" : effectivePublishMode(serverMode, broker);
}

/** El modo del corredor de un aviso (el sujeto). Un aviso que no existe es `dry-run`. */
export async function listingPublishMode(
  deps: BrokerDeps & { listings: Pick<ListingRepository, "get"> },
  serverMode: PublishMode,
  listingId: string,
): Promise<PublishMode> {
  if (serverMode !== "live") return "dry-run";
  const listing = await deps.listings.get(listingId);
  return listing === null ? "dry-run" : brokerPublishMode(deps, serverMode, listing.brokerId);
}

/** El modo de la marca de un post (el sujeto). Un post que no existe es `dry-run`. */
export async function postPublishMode(
  deps: BrokerDeps & { posts: Pick<PostRepository, "get"> },
  serverMode: PublishMode,
  postId: string,
): Promise<PublishMode> {
  if (serverMode !== "live") return "dry-run";
  const post = await deps.posts.get(postId);
  return post === null ? "dry-run" : brokerPublishMode(deps, serverMode, post.brokerId);
}

/**
 * El modo de la marca dueña de una cuenta. La cuenta de una publicación pertenece siempre a la marca
 * de su sujeto (el aviso o el post; la apertura de publicaciones lo hace cumplir): por eso la API
 * (por el sujeto) y el worker (por la cuenta) llegan a la misma marca. Sin cuenta, `dry-run`.
 */
export async function accountPublishMode(
  deps: BrokerDeps,
  serverMode: PublishMode,
  account: Pick<PlatformAccount, "brokerId"> | null,
): Promise<PublishMode> {
  return account === null ? "dry-run" : brokerPublishMode(deps, serverMode, account.brokerId);
}

/** El modo de una publicación por su id: el de la marca de su cuenta. Una que no existe, `dry-run`. */
export async function publicationPublishMode(
  deps: BrokerDeps & {
    publications: Pick<PublicationRepository, "get">;
    platformAccounts: Pick<PlatformAccountRepository, "get">;
  },
  serverMode: PublishMode,
  publicationId: string,
): Promise<PublishMode> {
  if (serverMode !== "live") return "dry-run";
  const publication = await deps.publications.get(publicationId);
  if (publication === null) return "dry-run";
  return accountPublishMode(
    deps,
    serverMode,
    await deps.platformAccounts.get(publication.platformAccountId),
  );
}

/**
 * Las marcas que están encendidas en vivo (`liveEnabled` y propias), sin mirar el servidor: para el
 * estado de la CLI y el banner de «Todos».
 */
export const liveEnabledBrokers = <T extends PublishModeBroker>(brokers: readonly T[]): T[] =>
  brokers.filter(brokerLiveEnabled);

/**
 * `PUBLISH_MODE_MISMATCH` (409) de algo que está en vivo y se quiere cambiar (pausar, cerrar,
 * actualizar, republicar, retirar borrando) en un pedido que corre en simulación. Con el servidor
 * en `live` (`serverMode`) la causa es la marca (apagada o ya no propia, ADR-0036) y el mensaje da
 * las dos salidas: encenderla o hacerlo a mano en la red. Sin `serverMode`, el mensaje de siempre.
 */
export function liveModeMismatch(options: {
  /** «Esta publicación está en vivo», «La propiedad tiene un aviso de Portal en vivo»… */
  what: string;
  /** «no se cambió nada en la plataforma», «no se republica»… */
  nothing: string;
  serverMode?: PublishMode | undefined;
  /** Para la salida a mano: Portal se cierra en Mercado Libre y se lee con `sync`. */
  portal?: boolean;
  /** Otra salida a mano (en vez de la de Portal o la genérica); `null` = sin salida a mano. */
  byHand?: string | null;
  publicationId?: string;
  details?: Record<string, unknown>;
}): AppError {
  const brandOff = options.serverMode === "live";
  const sync =
    options.publicationId === undefined
      ? "agentsales publications sync <id>"
      : `agentsales publications sync ${options.publicationId}`;
  const byHand =
    options.byHand !== undefined
      ? options.byHand
      : options.portal
        ? `ciérralo a mano en Mercado Libre y corre ${sync}`
        : "hazlo a mano en la red y márcalo en AgentSales";
  const turnOn = "enciende la marca (agentsales brokers live <slug> on --confirm <slug>)";
  const message = brandOff
    ? `${options.what}, pero la marca está apagada (o ya no es propia): ${options.nothing}. Para seguir, ${turnOn}${byHand === null ? "" : ` o ${byHand}`}`
    : `${options.what}, pero AgentSales está en simulación: ${options.nothing}`;
  return new AppError("PUBLISH_MODE_MISMATCH", message, {
    details: {
      ...options.details,
      ...(options.publicationId === undefined ? {} : { publicationId: options.publicationId }),
      cause: brandOff ? "brand_off" : "server_dry_run",
    },
  });
}
