import { useId } from "react";
import { useBrokers } from "../queries/brokers.js";
import { useBrokerScope, useRole, useScopedBroker } from "../scope/broker-scope.js";
import { Select } from "./ui/Field.js";

const BOX = "mt-4 rounded-lg border border-line bg-slate-50 px-3 py-2.5";
const CAPTION = "block text-xs font-medium text-fg-subtle";

/**
 * El corredor o la marca que se mira (spec F7 §4.11 y F9.5-T01). El administrador lo elige:
 * "Todos" o uno; filtra Propiedades, Seguimiento y Cuentas. Un corredor ve el suyo, sin elegir.
 */
export function BrokerSelector() {
  const role = useRole();
  const brokers = useBrokers();
  const scoped = useScopedBroker();
  const { selected, select } = useBrokerScope();
  const id = useId();
  if (role === "broker") {
    if (scoped === undefined) return null;
    return (
      <div className={BOX}>
        <span className={CAPTION}>{scoped.kind === "brand" ? "Marca" : "Corredor"}</span>
        <span className="block truncate text-sm font-semibold text-fg">{scoped.brandName}</span>
      </div>
    );
  }
  if (role !== "admin") return null;
  const known = brokers.data ?? [];
  // Un corredor elegido que ya no existe se muestra como "Todos" (y no filtra a nada).
  const value = known.some((broker) => broker.slug === selected) ? (selected ?? "") : "";
  return (
    <div className={BOX}>
      <label htmlFor={id} className={CAPTION}>
        Ver corredor
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => select(event.target.value === "" ? undefined : event.target.value)}
        className="mt-1"
      >
        <option value="">Todos</option>
        {known.map((broker) => (
          <option key={broker.id} value={broker.slug}>
            {broker.brandName}
          </option>
        ))}
      </Select>
    </div>
  );
}
