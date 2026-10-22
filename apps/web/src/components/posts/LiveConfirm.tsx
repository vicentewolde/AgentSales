import type { PublishMode } from "@agentsales/core";
import { useState } from "react";
import { useFreshPublishMode } from "../../queries/health.js";
import { needsLiveConfirm } from "../publications/publications.js";
import { Button } from "../ui/Button.js";

/**
 * Un botón que publica (o reintenta): como en los avisos (D11), justo antes vuelve a leer el modo
 * de la API y, si está en vivo o no se sabe, pide confirmar con un segundo clic. En simulación
 * conocida, publica de una.
 */
export function LiveConfirmButton({
  label,
  publishMode,
  pending,
  disabled = false,
  title,
  onConfirm,
}: {
  label: string;
  publishMode: PublishMode | undefined;
  pending: boolean;
  disabled?: boolean;
  title?: string;
  onConfirm: () => void;
}) {
  const freshMode = useFreshPublishMode();
  const [asking, setAsking] = useState<PublishMode | "unknown" | null>(null);
  const start = async () => {
    const mode = needsLiveConfirm(publishMode)
      ? publishMode
      : await freshMode().catch(() => undefined);
    if (needsLiveConfirm(mode)) {
      setAsking(mode ?? "unknown");
      return;
    }
    onConfirm();
  };
  if (asking !== null) {
    return (
      <div role="alert" className="rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm">
        <p className="font-semibold text-danger-800">
          {asking === "live"
            ? "La API está en vivo: esto publica de verdad en la red."
            : "No se pudo saber si la API está en vivo: si lo está, esto publica de verdad."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="danger"
            size="sm"
            disabled={pending}
            onClick={() => {
              setAsking(null);
              onConfirm();
            }}
          >
            Sí, publicar en vivo
          </Button>
          <Button variant="ghost" size="sm" autoFocus onClick={() => setAsking(null)}>
            Cancelar
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Button size="sm" disabled={pending || disabled} title={title} onClick={() => void start()}>
      {label}
    </Button>
  );
}
