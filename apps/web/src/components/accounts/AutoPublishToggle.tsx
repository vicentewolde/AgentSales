import type { Broker, PublishMode } from "@agentsales/core";
import { useState } from "react";
import { useSetAutoPublish } from "../../queries/brokers.js";
import { ErrorAlert } from "../ErrorAlert.js";

// F6-T13 (spec F6 §4.10): la publicación automática de un corredor.

/**
 * El interruptor de `auto_publish`: al activarlo pregunta, en rojo si la API está en vivo (o si no
 * se sabe): "publicará sin tu revisión". Apagarlo no pregunta.
 */
export function AutoPublishToggle({
  broker,
  publishMode,
}: {
  broker: Broker;
  publishMode: PublishMode | undefined;
}) {
  const set = useSetAutoPublish();
  const [confirming, setConfirming] = useState(false);
  const live = publishMode !== "dry-run";
  const cancel = () => setConfirming(false);

  return (
    <div className="mt-2 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={broker.autoPublish}
          disabled={set.isPending || confirming}
          onChange={(event) => {
            set.reset();
            if (event.target.checked) setConfirming(true);
            else set.mutate({ id: broker.id, autoPublish: false });
          }}
        />
        Publicación automática
        <span className="text-slate-500">
          (al preparar los textos, se aprueba lo que no tiene errores y se publica solo)
        </span>
      </label>
      {confirming && (
        <div
          role="alert"
          className={`mt-2 rounded-md border p-2 ${live ? "border-red-300 bg-red-50" : "border-slate-300 bg-slate-50"}`}
        >
          <p className={live ? "font-semibold text-red-800" : "text-slate-800"}>
            {publishMode === "live"
              ? "La API está en vivo: publicará sin tu revisión en Instagram y Portal (Marketplace queda como recordatorio)."
              : publishMode === undefined
                ? "No se sabe si la API está en vivo: si lo está, publicará sin tu revisión."
                : "En simulación no publica nada de verdad; en vivo publicará sin tu revisión."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              disabled={set.isPending}
              onClick={() =>
                set.mutate(
                  { id: broker.id, autoPublish: true },
                  { onSettled: () => setConfirming(false) },
                )
              }
            >
              Sí, activar
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="underline" onClick={cancel}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {set.error && <ErrorAlert error={set.error} />}
    </div>
  );
}
