import { useHealth } from "../queries/health.js";

// En simulación, una franja discreta; en vivo, roja y en negrita: tiene que verse siempre.
const TONE = {
  live: { bar: "bg-danger-700 font-semibold text-white", dot: "bg-white" },
  "dry-run": {
    bar: "border-b border-success-200 bg-success-50 font-medium text-success-800",
    dot: "bg-success-500",
  },
  unknown: {
    bar: "border-b border-line bg-slate-100 font-medium text-fg-muted",
    dot: "bg-slate-400",
  },
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

  // `auto_publish` en vivo (spec F6 §4.10): publica sin revisión. En vivo, no saberlo también se dice.
  const brokers = data?.autoPublishBrokers;
  const autoPublish =
    mode !== "live"
      ? null
      : brokers === null
        ? "No se pudo saber si algún corredor tiene publicación automática (la base no respondió)"
        : brokers !== undefined && brokers.length > 0
          ? `Publicación automática EN VIVO: publica sin tu revisión (${brokers.join(", ")})`
          : null;

  const tone = TONE[mode ?? "unknown"];
  return (
    <div
      role="status"
      aria-live={mode === "live" ? "assertive" : "polite"}
      className={`px-4 py-1.5 text-center text-xs sm:text-sm ${tone.bar}`}
    >
      <span aria-hidden="true" className={`mr-2 inline-block size-2 rounded-full ${tone.dot}`} />
      {text}
      {autoPublish !== null && <span className="block font-bold underline">{autoPublish}</span>}
    </div>
  );
}
