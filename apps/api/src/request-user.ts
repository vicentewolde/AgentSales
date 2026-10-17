import { AsyncLocalStorage } from "node:async_hooks";
import type { ListingLock, PublicationRepository } from "@agentsales/core";

// Quién hace el pedido, para la bitácora (spec F7 §4.3): `authenticate` guarda el usuario de la
// sesión mientras corre la ruta, y el candado de la app (`withEventUser`) lo pone en cada evento
// que se escribe dentro de él. Así core no lleva el usuario por cada caso de uso; lo del worker y
// lo de antes de F7 quedan sin usuario (`null`).

const store = new AsyncLocalStorage<{ userId: string | null }>();

/** Corre `fn` con el usuario del pedido. */
export function runWithUser<T>(userId: string | null, fn: () => T): T {
  return store.run({ userId }, fn);
}

/** El usuario del pedido en curso; `null` fuera de un pedido o sin sesión. */
export const currentUserId = (): string | null => store.getStore()?.userId ?? null;

type EventInput = { userId?: string | null };
const withUser = <E extends EventInput>(event: E): E =>
  event.userId === undefined ? { ...event, userId: currentUserId() } : event;

/** El repositorio de publicaciones que anota el usuario del pedido en cada evento. */
function withUserEvents(publications: PublicationRepository): PublicationRepository {
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

/** El candado de la app con los eventos firmados por el usuario del pedido. */
export function withEventUser(lock: ListingLock): ListingLock {
  return {
    run: (listingId, fn) =>
      lock.run(listingId, (repos) =>
        fn({ ...repos, publications: withUserEvents(repos.publications) }),
      ),
  };
}
