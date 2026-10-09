import { type Broker, mercadoLibreConnectCommands } from "@agentsales/core";
import { CopyCommand } from "./CopyCommand.js";

/**
 * Cómo conectar (o reconectar) la cuenta de Mercado Libre de un corredor (spec F4 §4.2 y §4.12):
 * sin túnel, en dos pasos de la CLI, el que abre el enlace de autorización y el que pega la
 * dirección de vuelta. Sin el par de la app en la API, lo dice en vez de mostrar los pasos.
 */
export function MercadoLibreConnectBox({
  broker,
  configured,
  redirectUri,
  reconnect,
}: {
  broker: Broker;
  configured: boolean;
  redirectUri: string;
  reconnect: boolean;
}) {
  const label = reconnect ? "Reconectar Mercado Libre" : "Conectar Mercado Libre";
  if (!configured) {
    return (
      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-amber-800">
          A la API le faltan ML_APP_ID y ML_CLIENT_SECRET en el .env: agrégalos y reiníciala para
          conectar Mercado Libre.
        </p>
      </div>
    );
  }
  const { authorize, paste } = mercadoLibreConnectCommands(broker.slug);
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-slate-600">
        Se conecta desde la terminal, en dos pasos (con la API corriendo):
      </p>
      <ol className="mt-1 list-decimal space-y-2 pl-5 text-slate-600">
        <li>
          Corre este comando: abre el enlace de Mercado Libre. Autoriza con la cuenta
          administradora.
          <CopyCommand
            command={authorize}
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
