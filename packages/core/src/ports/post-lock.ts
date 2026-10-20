import type { BrokerRepository } from "./broker-repository.js";
import type { ContentRepository, ContentRunRepository } from "./content-repository.js";
import type { MediaRepository } from "./media-repository.js";
import type { PlatformAccountRepository } from "./platform-account-repository.js";
import type { PostRepository, PostUploadRepository } from "./post-repository.js";
import type { PublicationRepository } from "./publication-repository.js";

/**
 * Repositorios atados a la transacción del candado del post: lo único que `fn` puede usar, como en
 * `ListingLock` (un repositorio de la conexión general se quedaría esperando la fila bloqueada).
 */
export type PostLockedRepositories = {
  brokers: BrokerRepository;
  posts: PostRepository;
  postUploads: PostUploadRepository;
  media: MediaRepository;
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
  publications: PublicationRepository;
  /** Sin `withCredentialsLock`: el candado de credenciales nunca se anida con otro (ADR-0015). */
  platformAccounts: Omit<PlatformAccountRepository, "withCredentialsLock">;
};

/**
 * Candado por post (ADR-0029, punto 3), con las mismas reglas que `ListingLock` (ADR-0014): pedir
 * los textos, editarlos, aprobar, quitar la aprobación, abrir publicaciones y pasarlas a
 * `publishing` corren dentro de `run`. En Postgres es una transacción que bloquea la fila del post
 * (`FOR NO KEY UPDATE`); si `fn` falla, nada de lo que escribió queda. El bloqueo es de la fila de
 * `posts`: nunca choca con el de un aviso, aunque los ids coincidieran. Reglas para `fn`:
 * - usa solo los repositorios que recibe;
 * - no encola, no toca R2 ni llama a plataformas: devuelve lo que haga falta y quien llamó encola
 *   **después** de que `run` termina, ya confirmado;
 * - un error de la base dentro de `fn` no se recupera;
 * - no se anida: ni un `run` del mismo post, ni el candado de un aviso, dentro de `fn`.
 * Un post que no existe es `POST_NOT_FOUND`.
 */
export interface PostLock {
  run<T>(postId: string, fn: (repos: PostLockedRepositories) => Promise<T>): Promise<T>;
}
