import type { PublishMode } from "@agentsales/core";
import { useState } from "react";
import { useFreshPublishMode } from "../../queries/health.js";
import { needsLiveConfirm } from "../publications/publications.js";

const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
const DANGER =
  "rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

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
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm">
        <p className="font-semibold text-red-800">
          {asking === "live"
            ? "La API está en vivo: esto publica de verdad en la red."
            : "No se pudo saber si la API está en vivo: si lo está, esto publica de verdad."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={DANGER}
            disabled={pending}
            onClick={() => {
              setAsking(null);
              onConfirm();
            }}
          >
            Sí, publicar en vivo
          </button>
          {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
          <button type="button" autoFocus className="underline" onClick={() => setAsking(null)}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={PRIMARY}
      disabled={pending || disabled}
      title={title}
      onClick={() => void start()}
    >
      {label}
    </button>
  );
}
