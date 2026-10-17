import type { Broker } from "@agentsales/core";
import { useActivateManualMarketplace } from "../../queries/accounts.js";
import { ErrorAlert } from "../ErrorAlert.js";

/**
 * Marketplace a mano (F7-T18, ADR-0023): para un corredor que no es propio, el administrador la
 * activa con un botón; el corredor publica él mismo con el texto y las fotos listos.
 */
export function MarketplaceManualBox({ broker, active }: { broker: Broker; active: boolean }) {
  const activate = useActivateManualMarketplace();
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="text-slate-700">
        {broker.operatorOwned
          ? "También puedes dejarlo a mano: el corredor publica él mismo, sin abrir Facebook en este Mac."
          : "Este corredor publica Marketplace a mano: el sistema deja listos el texto, las fotos y el precio, y él lo publica y confirma con el enlace."}
      </p>
      {active ? (
        <p className="mt-2 font-medium text-green-800">Marketplace a mano activo.</p>
      ) : (
        <button
          type="button"
          disabled={activate.isPending}
          onClick={() => activate.mutate(broker.slug)}
          className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {activate.isPending ? "Activando…" : "Activar Marketplace a mano"}
        </button>
      )}
      {activate.error && <ErrorAlert error={activate.error} />}
    </div>
  );
}
