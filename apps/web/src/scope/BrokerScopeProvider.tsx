import { type ReactNode, useCallback, useMemo, useState } from "react";
import { BROKER_SCOPE_STORAGE_KEY, BrokerScopeContext } from "./broker-scope.js";

function readStored(): string | undefined {
  try {
    return sessionStorage.getItem(BROKER_SCOPE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Guarda el corredor elegido en el selector (F7-T17) mientras dure la pestaña. */
export function BrokerScopeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<string | undefined>(readStored);
  const select = useCallback((slug: string | undefined) => {
    setStored(slug);
    try {
      if (slug === undefined) sessionStorage.removeItem(BROKER_SCOPE_STORAGE_KEY);
      else sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, slug);
    } catch {
      // Sin almacenamiento (modo privado): la elección dura hasta recargar.
    }
  }, []);
  const value = useMemo(() => ({ selected: stored, select }), [stored, select]);
  return <BrokerScopeContext.Provider value={value}>{children}</BrokerScopeContext.Provider>;
}
