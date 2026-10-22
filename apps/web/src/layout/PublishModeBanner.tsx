import { brokersLiveNow, effectivePublishMode, splitAutoPublish } from "@agentsales/core";
import { PUBLISH_MODE_BANNER_TEXT } from "../labels.js";
import { useHealth } from "../queries/health.js";
import { useScopedBroker } from "../scope/broker-scope.js";

// En simulación, una franja discreta; en vivo, roja y en negrita: tiene que verse siempre.
const TONE = {
  live: { bar: "bg-danger-700 font-semibold text-white", dot: "bg-surface" },
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
 * Banner permanente con el modo de publicación (F9.5-T22, ADR-0036): el de **la marca elegida**
 * («Simulación» o «En vivo» con su nombre), que sale del servidor (`PUBLISH_MODE` de la API en
 * ejecución, la fuente de verdad) y de la segunda llave de la marca (`live_enabled`). Con «Todos»,
 * el del servidor y cuántas marcas están en vivo. Un solo nodo `role="status"` que cambia de texto,
 * para que los lectores de pantalla anuncien el cambio; en vivo se anuncia de inmediato.
 */
export function PublishModeBanner() {
  const { data, isError, isPending } = useHealth();
  const scoped = useScopedBroker();
  const serverMode = data?.publishMode;

  // El modo que se muestra: el de la marca elegida, o con «Todos» el del servidor (rojo si alguna
  // marca publica de verdad o no se sabe cuáles).
  let mode: "live" | "dry-run" | undefined;
  let text: string;
  if (!data || !serverMode) {
    text = isPending ? PUBLISH_MODE_BANNER_TEXT.pending : PUBLISH_MODE_BANNER_TEXT.unknown;
  } else {
    if (scoped !== undefined) {
      mode = effectivePublishMode(serverMode, scoped);
      text =
        mode === "live"
          ? PUBLISH_MODE_BANNER_TEXT.brandLive(scoped.brandName)
          : PUBLISH_MODE_BANNER_TEXT.brandSimulation;
    } else if (serverMode === "live") {
      const live = brokersLiveNow(data);
      mode = live !== null && live.length === 0 ? "dry-run" : "live";
      text = PUBLISH_MODE_BANNER_TEXT.serverLive(live);
    } else {
      mode = "dry-run";
      text = PUBLISH_MODE_BANNER_TEXT["dry-run"];
    }
    if (isError) text = `${text} (último dato; el sistema no responde)`;
  }

  // `auto_publish` de verdad (spec F6 §4.10): publica sin revisión. Solo cuenta la marca encendida
  // con el servidor en vivo; no saberlo (la base no respondió) también se dice.
  const brokers = data?.autoPublishBrokers;
  let autoPublish: string | null = null;
  if (data && serverMode === "live") {
    const { live } = splitAutoPublish(data);
    const shown = scoped === undefined ? live : live.filter((slug) => slug === scoped.slug);
    if (brokers === null) {
      autoPublish =
        "No se pudo saber si algún corredor tiene publicación automática (la base no respondió)";
    } else if (shown.length > 0) {
      autoPublish = `Publicación automática EN VIVO: publica sin tu revisión (${shown.join(", ")})`;
    }
  }

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
