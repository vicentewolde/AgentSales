import { type Broker, mercadoLibreConnectCommands } from "@agentsales/core";
import { goTo } from "../../navigation.js";
import { useMercadoLibreAuthorizeUrl } from "../../queries/accounts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { CopyCommand } from "./CopyCommand.js";

/**
 * Cómo conectar (o reconectar) la cuenta de Mercado Libre de un corredor (spec F4 §4.2 y §4.12):
 * sin túnel, en dos pasos de la CLI, el que abre el enlace de autorización y el que pega la
 * dirección de vuelta. En el servidor con su dominio (`automatic`, F8-T19) es un botón: la vuelta
 * llega sola. Sin el par de la app en la API, lo dice en vez de mostrar los pasos.
 */
export function MercadoLibreConnectBox({
  broker,
  configured,
  redirectUri,
  automatic,
  reconnect,
}: {
  broker: Broker;
  configured: boolean;
  redirectUri: string;
  /** La vuelta es automática (el servidor con su dominio): un botón en vez de los pasos de la CLI. */
  automatic: boolean;
  reconnect: boolean;
}) {
  const label = reconnect ? "Reconectar Mercado Libre" : "Conectar Mercado Libre";
  const authorize = useMercadoLibreAuthorizeUrl();
  if (!configured) {
    return (
      <div className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-warning-800">
          A la API le faltan ML_APP_ID y ML_CLIENT_SECRET en el .env: agrégalos y reiníciala para
          conectar Mercado Libre.
        </p>
      </div>
    );
  }
  if (automatic) {
    // La URL trae su `state` y la respuesta puso la cookie: se abre en esta pestaña, y Mercado Libre
    // vuelve solo a la API, que termina en esta página.
    const go = () => authorize.mutate(broker.slug, { onSuccess: goTo });
    return (
      <div className="mt-3 text-sm">
        <Button
          size="sm"
          disabled={authorize.isPending}
          onClick={go}
          aria-label={`${label} de ${broker.brandName}`}
        >
          {authorize.isPending ? "Abriendo Mercado Libre…" : label}
        </Button>
        <p className="mt-1 text-fg-muted">
          Se abre Mercado Libre: entra con la cuenta administradora y autoriza (vale 10 min).
        </p>
        {authorize.error && <ErrorAlert error={authorize.error} />}
      </div>
    );
  }
  const { authorize: authorizeCommand, paste } = mercadoLibreConnectCommands(broker.slug);
  return (
    <div className="mt-3 rounded-lg border border-line bg-slate-50 p-3 text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-fg-muted">
        Se conecta desde la terminal, en dos pasos (con la API corriendo):
      </p>
      <ol className="mt-1 list-decimal space-y-2 pl-5 text-fg-muted">
        <li>
          Corre este comando: abre el enlace de Mercado Libre. Autoriza con la cuenta
          administradora.
          <CopyCommand
            command={authorizeCommand}
            label={`Copiar el comando que abre el enlace de ${broker.slug}`}
          />
        </li>
        <li>
          Al volver, el navegador muestra un error de conexión en{" "}
          <span className="break-all">{redirectUri}</span>: es lo esperado (si en cambio muestra un
          aviso de certificado, no continúes). Copia la dirección completa de la barra (vale 10 min)
          y corre:
          <CopyCommand
            command={paste}
            label={`Copiar el comando que pega la dirección de ${broker.slug}`}
          />
        </li>
      </ol>
    </div>
  );
}
