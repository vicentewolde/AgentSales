import type { Broker } from "@agentsales/core";
import { useState } from "react";
import { useActivateManualMarketplace } from "../../queries/accounts.js";
import { ErrorAlert } from "../ErrorAlert.js";

/**
 * Marketplace a mano (F7-T18, ADR-0023): el administrador la activa con un botón; el corredor
 * publica él mismo con el texto y las fotos listos. Si reemplaza un Facebook conectado (un corredor
 * propio), pregunta antes: se cierra esa sesión y se borra su perfil de este Mac.
 */
export function MarketplaceManualBox({
  broker,
  active,
  replacesProfile,
  automation,
}: {
  broker: Broker;
  active: boolean;
  /** Hay un Facebook conectado con el perfil del navegador que la cuenta a mano reemplazaría. */
  replacesProfile: boolean;
  /** Si el ambiente permite el formulario automático (en el servidor no: F8-T20, D4). */
  automation: boolean;
}) {
  const activate = useActivateManualMarketplace();
  const [confirming, setConfirming] = useState(false);
  const run = () => activate.mutate(broker.slug, { onSettled: () => setConfirming(false) });
  const cancel = () => setConfirming(false);
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="text-slate-700">
        {!automation
          ? "En el servidor Marketplace se publica a mano: el sistema deja listos el texto, las fotos y el precio, y el corredor lo publica y confirma con el enlace."
          : broker.operatorOwned
            ? "También puedes dejarlo a mano: el corredor publica él mismo, sin abrir Facebook en este Mac."
            : "Este corredor publica Marketplace a mano: el sistema deja listos el texto, las fotos y el precio, y él lo publica y confirma con el enlace."}
        {!automation &&
          replacesProfile &&
          " La cuenta de Facebook que quedó conectada deja de usarse; no se borra ningún archivo."}
      </p>
      {active ? (
        <p className="mt-2 font-medium text-green-800">Marketplace a mano activo.</p>
      ) : confirming ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2">
          <span>
            Se cierra la sesión de Facebook de {broker.brandName} y se borra su perfil de este Mac.
            ¿Activar Marketplace a mano?
          </span>
          <button
            type="button"
            disabled={activate.isPending}
            onClick={run}
            className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {activate.isPending ? "Activando…" : "Sí, activar a mano"}
          </button>
          {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
          <button type="button" autoFocus onClick={cancel} className="underline">
            Cancelar
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={activate.isPending}
          onClick={() => (replacesProfile && automation ? setConfirming(true) : run())}
          className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {activate.isPending ? "Activando…" : "Activar Marketplace a mano"}
        </button>
      )}
      {activate.error && <ErrorAlert error={activate.error} />}
    </div>
  );
}
