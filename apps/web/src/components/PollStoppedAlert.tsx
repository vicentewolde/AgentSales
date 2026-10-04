import { RUN_WAIT } from "@agentsales/core";
import type { PollStop } from "../queries/run-poll.js";

const MAX_WAIT_HOURS = RUN_WAIT.maxWaitMs / (60 * 60 * 1000);

/**
 * El aviso de que se dejó de consultar una corrida en curso (`pollStop`), con un botón para
 * consultar de nuevo. Lo usan la página de una carga y la sección Contenido.
 */
export function PollStoppedAlert({
  stopped,
  noun,
  onRetry,
  retrying,
}: {
  stopped: PollStop;
  /** `La carga`, `La preparación`. */
  noun: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="font-semibold text-amber-900">
        {stopped === "failures"
          ? "Dejé de consultar: la API no respondió varias veces seguidas."
          : `Dejé de consultar: ${noun.toLowerCase()} lleva más de ${MAX_WAIT_HOURS} horas sin terminar.`}
      </p>
      <p className="mt-1 text-sm text-amber-800">
        {noun} sigue en el worker. Revisa que estén corriendo la API y el worker (pnpm dev).
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-3 rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {retrying ? "Consultando…" : "Consultar de nuevo"}
      </button>
    </div>
  );
}
