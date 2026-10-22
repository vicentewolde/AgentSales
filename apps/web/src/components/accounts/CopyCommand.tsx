import { useState } from "react";
import { Button } from "../ui/Button.js";

type CopyState = "idle" | "copied" | "failed";

/** Un comando de la CLI para copiar, con el aviso de si se copió o no (`label` nombra el botón). */
export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="rounded bg-surface px-2 py-1 text-xs break-all">{command}</code>
      <Button
        variant="link"
        onClick={() => void copyCommand()}
        aria-label={label}
        className="text-xs"
      >
        Copiar
      </Button>
      <span role="status" className="text-xs text-fg-muted">
        {copy === "copied" && "Copiado"}
        {copy === "failed" && "No se pudo copiar: selecciónalo a mano"}
      </span>
    </div>
  );
}
