import {
  type AccessScope,
  AppError,
  type BrokerRepository,
  brokerScope,
  inScope,
} from "@agentsales/core";
import type { Context, MiddlewareHandler } from "hono";
import { type AppEnv, requireAuth } from "./auth.js";

// Cada corredor ve solo lo suyo (spec F7 §4.4, ADR-0022). Las listas filtran en SQL con el alcance
// de la sesión; lo que se pide por id pasa por `ownedBy`, que responde "no existe" (404, el mismo
// cuerpo que un id que no existe) a lo de otro corredor.

/** El alcance de la sesión del pedido. */
export const requestScope = (c: Context<AppEnv>): AccessScope => requireAuth(c).scope;

/**
 * El alcance de una lista con `?broker=<slug>`: el administrador filtra por ese corredor; un
 * corredor que pide otro recibe 404, como con un `slug` que no existe (es un filtro, no un permiso).
 */
export async function listScope(
  c: Context<AppEnv>,
  brokers: Pick<BrokerRepository, "findBySlug">,
  slug: string | undefined,
): Promise<AccessScope> {
  const scope = requestScope(c);
  if (slug === undefined) return scope;
  const broker = await brokers.findBySlug(slug);
  if (broker === null || !inScope(scope, broker.id)) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`, {
      details: { broker: slug },
    });
  }
  return brokerScope(broker.id);
}

/** El corredor dueño de un recurso por su id; `null` si no existe (o no tiene corredor). */
export type OwnerOf = (id: string) => Promise<string | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Para un usuario de corredor, el recurso `:id` del pedido tiene que ser suyo: si no existe, es de
 * otro corredor o el `:id` no es un uuid, `notFound(id)` (los mismos cuerpos). Falla cerrado: las
 * rutas cuyo segundo tramo no es un id (`/imports/local`, `/accounts/mercadolibre/…`) son del
 * administrador, y `authenticate` ya las cortó antes. El administrador pasa sin consultar.
 */
export function ownedBy(
  ownerOf: OwnerOf,
  notFound: (id: string) => AppError,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scope = c.get("auth")?.scope;
    const id = c.req.param("id");
    if (scope?.kind === "broker" && id !== undefined) {
      const owner = UUID.test(id) ? await ownerOf(id) : null;
      if (owner === null || !inScope(scope, owner)) throw notFound(id);
    }
    return next();
  };
}
