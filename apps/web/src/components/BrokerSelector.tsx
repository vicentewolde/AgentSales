import { useId } from "react";
import { useBrokers } from "../queries/brokers.js";
import { useBrokerScope, useRole } from "../scope/broker-scope.js";

/**
 * El selector de corredor del administrador (spec F7 §4.11): "Todos" o uno; filtra Propiedades,
 * Seguimiento y Cuentas. Un corredor no lo ve.
 */
export function BrokerSelector() {
  const role = useRole();
  const brokers = useBrokers();
  const { selected, select } = useBrokerScope();
  const id = useId();
  if (role !== "admin") return null;
  const known = brokers.data ?? [];
  // Un corredor elegido que ya no existe se muestra como "Todos" (y no filtra a nada).
  const value = known.some((broker) => broker.slug === selected) ? (selected ?? "") : "";
  return (
    <div className="mt-3 px-3 md:mt-4">
      <label htmlFor={id} className="block text-xs font-medium text-slate-500">
        Ver corredor
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => select(event.target.value === "" ? undefined : event.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
      >
        <option value="">Todos</option>
        {known.map((broker) => (
          <option key={broker.id} value={broker.slug}>
            {broker.brandName}
          </option>
        ))}
      </select>
    </div>
  );
}
