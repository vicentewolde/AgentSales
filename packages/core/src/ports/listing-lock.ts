import type { BrokerRepository } from "./broker-repository.js";
import type { ContentRepository, ContentRunRepository } from "./content-repository.js";
import type { ListingRepository } from "./listing-repository.js";
import type { MediaRepository } from "./media-repository.js";
import type { PlatformAccountRepository } from "./platform-account-repository.js";
import type { PublicationRepository } from "./publication-repository.js";

/**
 * Repositorios atados a la transacción del candado: lo único que `fn` puede usar (spec F3 §4.2).
 * Un repositorio de la conexión general se quedaría esperando la fila bloqueada (en PGlite, que
 * tiene una sola conexión, siempre).
 */
export type LockedRepositories = {
  brokers: BrokerRepository;
  listings: ListingRepository;
  media: MediaRepository;
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
  publications: PublicationRepository;
  /**
   * Sin `withCredentialsLock`: el candado de credenciales nunca se anida con el del aviso (ADR-0015),
   * y el tipo lo impide.
   */
  platformAccounts: Omit<PlatformAccountRepository, "withCredentialsLock">;
};

/**
 * Candado por aviso (ADR-0014, spec F3 §4.2): pedir una corrida, editar, aprobar, quitar la
 * aprobación, abrir publicaciones y pasarlas a `publishing` corren dentro de `run`, así la revisión
 * de su condición y la escritura son una sola cosa. En Postgres es una transacción que bloquea la
 * fila del aviso (`FOR NO KEY UPDATE`); si `fn` falla, nada de lo que escribió queda.
 * Reglas para `fn`:
 * - usa solo los repositorios que recibe;
 * - no encola, no toca R2 ni llama a plataformas: devuelve lo que haga falta (por ejemplo, ids) y
 *   quien llamó encola **después** de que `run` termina, ya confirmado;
 * - un error de la base dentro de `fn` no se recupera: aunque las escrituras de los repositorios
 *   corren como savepoints (y algunas se podrían retomar), la regla prudente es dejar que falle;
 * - no se anida: un `run` del mismo aviso dentro de `fn` se espera a sí mismo para siempre.
 * Un aviso que no existe es `LISTING_NOT_FOUND`.
 */
export interface ListingLock {
  run<T>(listingId: string, fn: (repos: LockedRepositories) => Promise<T>): Promise<T>;
}
