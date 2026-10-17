import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useMe } from "../queries/auth.js";
import { useBrokers } from "../queries/brokers.js";

// El alcance del panel (spec F7 §4.11): el administrador elige un corredor ("Todos" o uno) y las
// listas, Seguimiento y Cuentas se filtran con él; un corredor ve siempre lo suyo (la API ya lo
// limita) y no ve el selector. La elección dura la pestaña (`sessionStorage`).

const STORAGE_KEY = "agentsales.corredor";

type BrokerScope = {
  /** El `slug` elegido por el administrador; `undefined` = todos (o un corredor: lo suyo). */
  selected: string | undefined;
  select: (slug: string | undefined) => void;
};

const BrokerScopeContext = createContext<BrokerScope>({ selected: undefined, select: () => {} });

function readStored(): string | undefined {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function BrokerScopeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<string | undefined>(readStored);
  const select = useCallback((slug: string | undefined) => {
    setStored(slug);
    try {
      if (slug === undefined) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, slug);
    } catch {
      // Sin almacenamiento (modo privado): la elección dura hasta recargar.
    }
  }, []);
  const value = useMemo(() => ({ selected: stored, select }), [stored, select]);
  return <BrokerScopeContext.Provider value={value}>{children}</BrokerScopeContext.Provider>;
}

/** El rol de la sesión: `admin`, `broker` o `null` mientras carga (no se muestra nada de más). */
export function useRole(): "admin" | "broker" | null {
  const me = useMe();
  return me.data?.role ?? null;
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
