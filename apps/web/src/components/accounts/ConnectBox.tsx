import { type Broker, tokenStdinCommand } from "@agentsales/core";
import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

/**
 * Cómo conectar (o reconectar) la cuenta de un corredor: el enlace del OAuth solo con `https` (F7),
 * directo a la API (no por el proxy `/api`: la cookie del `state` va en su host); en F3 (D4), el
 * comando de la CLI con el token del panel de Meta, para copiar.
 */
export function ConnectBox({
  broker,
  oauth,
  startUrl,
  reconnect,
}: {
  broker: Broker;
  oauth: boolean;
  startUrl: string;
  reconnect: boolean;
}) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const label = reconnect ? "Reconectar Instagram" : "Conectar Instagram";
  if (oauth) {
    return (
      <a
        href={`${startUrl}?broker=${encodeURIComponent(broker.slug)}`}
        aria-label={`${label} de ${broker.brandName}`}
        className="mt-3 inline-block rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
      >
        {label}
      </a>
    );
  }
  const command = tokenStdinCommand(broker.slug);
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-slate-600">
        Meta no acepta la conexión desde localhost: se conecta con el token del panel de Meta, en
        este orden (el comando lee el token del portapapeles):
      </p>
      <ol className="mt-1 list-decimal pl-5 text-slate-600">
        <li>Copia este comando y pégalo en la terminal, sin ejecutarlo.</li>
        <li>En el panel de Meta (Instagram API setup), copia el token del botón Generate token.</li>
        <li>Vuelve a la terminal y presiona Enter.</li>
      </ol>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-white px-2 py-1 text-xs break-all">{command}</code>
        <button
          type="button"
          onClick={() => void copyCommand()}
          aria-label={`Copiar el comando de ${broker.slug}`}
          className="text-xs underline"
        >
          Copiar
        </button>
        <span role="status" className="text-xs text-slate-600">
          {copy === "copied" && "Copiado"}
          {copy === "failed" && "No se pudo copiar: selecciónalo a mano"}
        </span>
      </div>
    </div>
  );
}
