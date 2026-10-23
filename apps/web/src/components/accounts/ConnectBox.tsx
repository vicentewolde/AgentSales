import { type Broker, tokenStdinCommand } from "@agentsales/core";
import { Link } from "react-router";
import { buttonClasses } from "../ui/styles.js";
import { CopyCommand } from "./CopyCommand.js";

/**
 * Cómo conectar (o reconectar) la cuenta de un corredor: con el OAuth (solo `https`, F7), el botón
 * lleva a la pantalla previa `/cuentas/instagram` (F9.5-T20), que explica qué se autoriza y sigue
 * al inicio que da la API en el host de su vuelta (la cookie del `state` va en ese host; en
 * internet es el mismo del panel, spec F8 §4.3); en F3 (D4), el
 * comando de la CLI con el token del panel de Meta, para copiar.
 */
export function ConnectBox({
  broker,
  oauth,
  reconnect,
}: {
  broker: Broker;
  oauth: boolean;
  reconnect: boolean;
}) {
  const label = reconnect ? "Reconectar Instagram" : "Conectar Instagram";
  if (oauth) {
    return (
      <Link
        to={`/cuentas/instagram?broker=${encodeURIComponent(broker.slug)}`}
        aria-label={`${label} de ${broker.brandName}`}
        className={`mt-3 ${buttonClasses("primary", "sm")}`}
      >
        {label}
      </Link>
    );
  }
  const command = tokenStdinCommand(broker.slug);
  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas p-3 text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-fg-muted">
        Meta no acepta la conexión desde localhost: se conecta con el token del panel de Meta, en
        este orden (el comando lee el token del portapapeles):
      </p>
      <ol className="mt-1 list-decimal pl-5 text-fg-muted">
        <li>Copia este comando y pégalo en la terminal, sin ejecutarlo.</li>
        <li>En el panel de Meta (Instagram API setup), copia el token del botón Generate token.</li>
        <li>Vuelve a la terminal y presiona Enter.</li>
      </ol>
      <CopyCommand command={command} label={`Copiar el comando de ${broker.slug}`} />
    </div>
  );
}
