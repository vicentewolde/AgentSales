import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./request-context.js";

/**
 * `RequestContext` con `AsyncLocalStorage`: el usuario sigue a cada pedido a través de sus
 * `await`, sin cruzarse con otros pedidos concurrentes. Solo lo importan `server.ts` y `testing/`
 * (este módulo no llega a `AppType`).
 */
export function createRequestContext(): RequestContext {
  const store = new AsyncLocalStorage<{ userId: string | null }>();
  return {
    run: (userId, fn) => store.run({ userId }, fn),
    currentUserId: () => store.getStore()?.userId ?? null,
  };
}
