import type { ListingLock, PublicationRepository } from "@agentsales/core";

// Quién hace el pedido, para la bitácora (spec F7 §4.3, seguimiento de ADR-0021): `authenticate`
// corre cada pedido con el usuario de la sesión (`RequestContext.run`) y el candado de la app
// (`withEventUser`) lo pone en cada evento que se escribe dentro de él. Así core no lleva el
// usuario por cada caso de uso; lo del worker y lo de antes de F7 quedan sin usuario (`null`).
// La implementación con `AsyncLocalStorage` (Node) vive en `request-context-node.ts`, que solo
// importan `server.ts` y `testing/`: este módulo llega a `AppType` y no puede importar `node:*`.

/** El usuario del pedido en curso. */
export type RequestContext = {
  /** Corre `fn` con el usuario del pedido. */
  run<T>(userId: string | null, fn: () => T): T;
  /** El usuario del pedido en curso; `null` fuera de un pedido o sin sesión. */
  currentUserId(): string | null;
};

type EventInput = { userId?: string | null };

/** El repositorio de publicaciones que anota el usuario del pedido en cada evento. */
function withUserEvents(
  publications: PublicationRepository,
  context: RequestContext,
): PublicationRepository {
  const withUser = <E extends EventInput>(event: E): E =>
    event.userId === undefined ? { ...event, userId: context.currentUserId() } : event;
  return {
    ...publications,
    create: (publication, event) => publications.create(publication, withUser(event)),
    transition: (id, change, event) => publications.transition(id, change, withUser(event)),
    reschedule: (id, change, event) => publications.reschedule(id, change, withUser(event)),
    replacePublishedSource: (id, guard, source, event) =>
      publications.replacePublishedSource(id, guard, source, withUser(event)),
    setRemoteState: (id, remoteState, event) =>
      publications.setRemoteState(
        id,
        remoteState,
        event === undefined ? undefined : withUser(event),
      ),
    addEvent: (id, event) => publications.addEvent(id, withUser(event)),
  };
}

/**
 * El candado de la app con los eventos firmados por el usuario del pedido. Toda escritura de la
 * API pasa por aquí: `AppDeps.publications` es de solo lectura (el tipo lo hace cumplir).
 */
export function withEventUser(lock: ListingLock, context: RequestContext): ListingLock {
  return {
    run: (listingId, fn) =>
      lock.run(listingId, (repos) =>
        fn({ ...repos, publications: withUserEvents(repos.publications, context) }),
      ),
  };
}
