import {
  type Broker,
  marketplaceConnectCommand,
  marketplaceLoginErrorText,
} from "@agentsales/core";
import { useState } from "react";
import {
  type MarketplaceLoginRequest,
  useMarketplaceLogin,
  useMarketplaceLoginWait,
} from "../../queries/accounts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { CopyCommand } from "./CopyCommand.js";

/** Lo que dice la caja mientras espera y cuando termina (spec F5 §4.2). */
function WaitText({ request }: { request: MarketplaceLoginRequest }) {
  const wait = useMarketplaceLoginWait(request);
  if (wait === null || wait.outcome === "pending") {
    return (
      <p className="mt-2 text-slate-700">
        Se abrirá una ventana de Chromium con Facebook: inicia sesión ahí a mano (también la
        verificación, si la pide). Espero hasta 10 min. Si cierras la ventana sin iniciar sesión,
        vuelve a intentarlo.
      </p>
    );
  }
  if (wait.outcome === "connected") {
    return <p className="mt-2 font-medium text-emerald-800">Listo: la cuenta quedó conectada.</p>;
  }
  if (wait.outcome === "failed") {
    return <p className="mt-2 text-red-700">{marketplaceLoginErrorText(wait.code)}</p>;
  }
  if (wait.outcome === "unreachable") {
    return (
      <p className="mt-2 text-red-700">
        La API dejó de responder mientras esperaba: recarga la página para ver si se conectó.
      </p>
    );
  }
  return (
    <p className="mt-2 text-red-700">
      No llegó respuesta del worker: revisa que esté corriendo (pnpm dev) y vuelve a intentarlo.
    </p>
  );
}

/**
 * Cómo conectar (o reconectar) la cuenta de Marketplace de un corredor (spec F5 §4.2 y §4.12):
 * "Iniciar sesión en Facebook" encola el inicio de sesión y el worker abre una ventana de Chromium,
 * donde el operador inicia sesión a mano; la caja espera hasta ver la sesión o el motivo del fallo.
 * Abre Facebook también en simulación: no publica (ADR-0017 punto 7). El comando de la CLI hace lo
 * mismo.
 */
export function MarketplaceConnectBox({
  broker,
  reconnect,
}: {
  broker: Broker;
  reconnect: boolean;
}) {
  const login = useMarketplaceLogin();
  const [request, setRequest] = useState<MarketplaceLoginRequest | null>(null);
  const start = () => {
    setRequest(null);
    login.mutate({ broker: broker.slug }, { onSuccess: setRequest });
  };
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-medium">{reconnect ? "Reconectar Marketplace" : "Conectar Marketplace"}</p>
      <p className="mt-1 text-slate-600">
        AgentSales no guarda tu clave: la sesión queda en un perfil de Chromium de este equipo. El
        worker abre la ventana (tiene que estar corriendo: pnpm dev).
      </p>
      <button
        type="button"
        onClick={start}
        disabled={login.isPending}
        className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
      >
        {login.isPending ? "Pidiendo la ventana…" : "Iniciar sesión en Facebook"}
      </button>
      {/* Siempre montada: los lectores de pantalla anuncian el avance de la espera. */}
      <div aria-live="polite">
        {request !== null && <WaitText key={request.startedAt} request={request} />}
      </div>
      {login.error && <ErrorAlert error={login.error} />}
      <p className="mt-2 text-slate-600">O desde la terminal:</p>
      <CopyCommand
        command={marketplaceConnectCommand(broker.slug)}
        label={`Copiar el comando que conecta Marketplace de ${broker.slug}`}
      />
    </div>
  );
}
