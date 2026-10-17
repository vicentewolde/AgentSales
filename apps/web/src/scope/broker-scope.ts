import { can, type Permission } from "@agentsales/core";
import { createContext, useContext } from "react";
import { useMe } from "../queries/auth.js";
import { useBrokers } from "../queries/brokers.js";

// El alcance del panel (spec F7 §4.11): el administrador elige un corredor ("Todos" o uno) y las
// listas, Seguimiento y Cuentas se filtran con él; un corredor ve siempre lo suyo (la API ya lo
// limita) y no ve el selector. La elección dura la pestaña (`sessionStorage`). Lo que cada uno
// puede hacer sale de `can` (core, spec F7 §4.5), no del rol a mano.

export const BROKER_SCOPE_STORAGE_KEY = "agentsales.corredor";

export type BrokerScope = {
  /** El `slug` elegido por el administrador; `undefined` = todos (o un corredor: lo suyo). */
  selected: string | undefined;
  select: (slug: string | undefined) => void;
};

export const BrokerScopeContext = createContext<BrokerScope>({
  selected: undefined,
  select: () => {},
});

/** El rol de la sesión: `admin`, `broker` o `null` mientras carga (no se muestra nada de más). */
export function useRole(): "admin" | "broker" | null {
  const me = useMe();
  return me.data?.role ?? null;
}

/**
 * Si la sesión puede hacer `permission` (sobre `brokerId`, si la acción es de un corredor). Mientras
 * no se sabe quién es, no (nada de más a la vista).
 */
export function useCan(permission: Permission, brokerId?: string | null): boolean {
  const me = useMe();
  return me.data !== undefined && can(me.data, permission, brokerId);
}

/**
 * El corredor con que se filtra: el elegido por el administrador; para un corredor, `undefined`
 * (la API ya le da solo lo suyo).
 */
export function useBrokerFilter(): string | undefined {
  const { selected } = useContext(BrokerScopeContext);
  const admin = useRole() === "admin";
  const brokers = useBrokers();
  if (!admin || selected === undefined) return undefined;
  // Uno que ya no existe (o todavía no se sabe) no filtra: la API respondería "no existe".
  return brokers.data?.some((broker) => broker.slug === selected) ? selected : undefined;
}

export function useBrokerScope(): BrokerScope {
  return useContext(BrokerScopeContext);
}
