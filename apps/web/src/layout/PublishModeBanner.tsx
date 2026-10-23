import { PUBLISH_MODE_BANNER_TEXT } from "../labels.js";
import { useHealth } from "../queries/health.js";

// En simulación, una franja discreta; en vivo, roja y en negrita: tiene que verse siempre.
const TONE = {
  live: { bar: "bg-danger-700 font-semibold text-surface", dot: "bg-surface" },
  "dry-run": {
    bar: "border-b border-success-200 bg-success-50 font-medium text-success-800",
    dot: "bg-success-500",
  },
  unknown: {
    bar: "border-b border-line-strong bg-sand font-medium text-fg-muted",
    dot: "bg-fg-subtle",
  },
} as const;

/**
 * Banner permanente con el modo de publicación del sistema (`PUBLISH_MODE` de la API en ejecución,
 * la fuente de verdad). Un solo nodo `role="status"` que cambia de texto, para que los lectores de
 * pantalla anuncien el cambio; en vivo se anuncia de inmediato.
 */
export function PublishModeBanner() {
  const { data, isError, isPending } = useHealth();
  const mode = data?.publishMode;

  let text: string;
  if (!mode) {
    text = isPending ? PUBLISH_MODE_BANNER_TEXT.pending : PUBLISH_MODE_BANNER_TEXT.unknown;
  } else {
    const label = PUBLISH_MODE_BANNER_TEXT[mode];
    text = isError ? `${label} (último dato; el sistema no responde)` : label;
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
