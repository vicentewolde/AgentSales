import { useHealth } from "../health.js";

const TONE = {
  live: "bg-red-700 font-bold",
  "dry-run": "bg-emerald-700 font-medium",
  unknown: "bg-slate-600 font-medium",
} as const;

/**
 * Banner permanente con el `PUBLISH_MODE` de la API en ejecución (fuente de verdad). Un solo nodo
 * `role="status"` que cambia de texto, para que los lectores de pantalla anuncien el cambio;
 * `live` se anuncia de inmediato.
 */
export function PublishModeBanner() {
  const { data, isError, isPending } = useHealth();
  const mode = data?.publishMode;

  let text: string;
  if (!mode) {
    text = isPending ? "Consultando PUBLISH_MODE…" : "PUBLISH_MODE desconocido: la API no responde";
  } else {
    const label =
      mode === "live"
        ? "PUBLISH_MODE: LIVE — las publicaciones son reales"
        : "PUBLISH_MODE: dry-run — no se publica nada";
    text = isError ? `${label} (último dato; la API no responde)` : label;
  }

  return (
    <div
      role="status"
      aria-live={mode === "live" ? "assertive" : "polite"}
      className={`px-4 py-2 text-center text-sm text-white ${TONE[mode ?? "unknown"]}`}
    >
      {text}
    </div>
  );
}
