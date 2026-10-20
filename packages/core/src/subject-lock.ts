import type { ListingLock, LockedRepositories } from "./ports/listing-lock.js";
import type { PostLock, PostLockedRepositories } from "./ports/post-lock.js";
import {
  type ListingSubject,
  type PostSubject,
  type Subject,
  subjectNotListing,
} from "./subject.js";

/**
 * Los candados de los dos sujetos (ADR-0029, punto 3). `postLock` falta en quien solo trabaja con
 * avisos (por ejemplo, `auto_publish`, que no aplica a los posts, ADR-0030): ahí un post es
 * `SUBJECT_NOT_LISTING`, no reintentable, antes de tomar ningún candado.
 */
export type SubjectLocks = { lock: ListingLock; postLock?: PostLock };

/** Los repositorios que traen los dos candados: lo común que un caso de uso usa sin bifurcar. */
export type SubjectLockedRepositories = Pick<
  LockedRepositories,
  "brokers" | "media" | "contentRuns" | "contents" | "publications" | "platformAccounts"
>;

// Si `PostLockedRepositories` deja de traer algo de lo común, esto no compila.
const _postReposAreCommon = (repos: PostLockedRepositories): SubjectLockedRepositories => repos;
void _postReposAreCommon;

/**
 * Lo que recibe `fn` dentro del candado: el sujeto y los repositorios de **su** candado. `kind`
 * discrimina: con `kind === "listing"`, `repos` trae `listings`; con `"post"`, `posts`. Lo común
 * (`repos.contents`, `repos.publications`…) se usa sin preguntar.
 */
export type LockedSubject =
  | { kind: "listing"; subject: ListingSubject; repos: LockedRepositories }
  | { kind: "post"; subject: PostSubject; repos: PostLockedRepositories };

/**
 * Corre `fn` dentro del candado del sujeto: el del aviso (`ListingLock`) o el del post (`PostLock`).
 * Las reglas son las de los dos candados: `fn` usa solo los repositorios que recibe, no encola ni
 * llama a la red ni a R2 (quien llamó lo hace después, ya confirmado), un error de la base no se
 * recupera, y no se anida (ni otro `runOnSubject`, ni un candado del mismo u otro sujeto). `fn`
 * trabaja solo con su sujeto: nada de lo que lee o escribe es de otro aviso u otro post.
 * Errores: `LISTING_NOT_FOUND` o `POST_NOT_FOUND` (los da el candado), y `SUBJECT_NOT_LISTING` si
 * el sujeto es un post y no hay `postLock`.
 */
export async function runOnSubject<T>(
  locks: SubjectLocks,
  subject: Subject,
  fn: (locked: LockedSubject) => Promise<T>,
): Promise<T> {
  if (subject.kind === "listing") {
    const listing: ListingSubject = { kind: "listing", id: subject.id };
    return locks.lock.run(listing.id, (repos) => fn({ kind: "listing", subject: listing, repos }));
  }
  const { postLock } = locks;
  const post: PostSubject = { kind: "post", id: subject.id };
  // Quien no tiene el candado del post solo trabaja con avisos: el mismo error que `listingIdOf`.
  if (postLock === undefined) throw subjectNotListing(post);
  return postLock.run(post.id, (repos) => fn({ kind: "post", subject: post, repos }));
}
