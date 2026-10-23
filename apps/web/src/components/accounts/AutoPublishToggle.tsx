import type { Broker, PublishMode } from "@agentsales/core";
import { useState } from "react";
import { useSetAutoPublish } from "../../queries/brokers.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";

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
        <span className="text-fg-subtle">
          (al preparar los textos, se aprueba lo que no tiene errores y se publica solo)
        </span>
      </label>
      {confirming && (
        <div
          role="alert"
          className={`mt-2 rounded-md border p-2 ${live ? "border-danger-200 bg-danger-50" : "border-line-soft bg-canvas"}`}
        >
          <p className={live ? "font-semibold text-danger-800" : "text-fg"}>
            {publishMode === "live"
              ? "El sistema está en vivo: publicará sin tu revisión en Instagram y Portal (Marketplace queda como recordatorio)."
              : publishMode === undefined
                ? "No se sabe si el sistema está en vivo: si lo está, publicará sin tu revisión."
                : "En simulación no publica nada de verdad; en vivo publicará sin tu revisión."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={set.isPending}
              onClick={() =>
                set.mutate(
                  { id: broker.id, autoPublish: true },
                  { onSettled: () => setConfirming(false) },
                )
              }
            >
              Sí, activar
            </Button>
            <Button variant="link" autoFocus onClick={cancel}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {set.error && <ErrorAlert error={set.error} />}
    </div>
  );
}
