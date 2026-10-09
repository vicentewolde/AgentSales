import type { PlatformAccountView } from "@agentsales/api/contracts";
import { PLATFORM_ACCOUNT_STATUS_TEXT } from "@agentsales/core";
import { useRef, useState } from "react";
import { ACCOUNT_STATUS_TONE } from "../../labels.js";
import { useDisconnectAccount } from "../../queries/accounts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { AccountExpiry } from "./AccountExpiry.js";
import { accountDateText } from "./accounts.js";

/**
 * Una cuenta conectada (Instagram o Mercado Libre, desde F4-T21): estado, vencimiento, renovación,
 * permisos y Desconectar con confirmación. El nombre va tal cual (Mercado Libre: el `nickname`).
 */
export function AccountCard({ account, now }: { account: PlatformAccountView; now: Date }) {
  const disconnect = useDisconnectAccount();
  const [confirming, setConfirming] = useState(false);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const ask = () => {
    disconnect.reset();
    setConfirming(true);
  };
  const cancel = () => {
    disconnect.reset();
    setConfirming(false);
    // El botón vuelve a aparecer: el foco vuelve a él.
    requestAnimationFrame(() => disconnectButton.current?.focus());
  };
  return (
    <article
      aria-label={`Cuenta ${account.displayName}`}
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{account.displayName}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ACCOUNT_STATUS_TONE[account.status]}`}
        >
          {PLATFORM_ACCOUNT_STATUS_TEXT[account.status]}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Vence</dt>
        <dd>
          <AccountExpiry account={account} now={now} />
        </dd>
        <dt className="text-slate-500">Última renovación</dt>
        <dd>
          {account.tokenRefreshedAt === null
            ? account.platform === "portal_inmobiliario"
              ? "Todavía no (se renueva sola cada 7 días mientras el worker corre)"
              : "Todavía no (se renueva sola a las 24 h de conectarla)"
            : accountDateText(account.tokenRefreshedAt)}
        </dd>
        <dt className="text-slate-500">Tipo</dt>
        <dd>{account.accountType ?? "—"}</dd>
        <dt className="text-slate-500">Permisos</dt>
        <dd>
          {account.permissions === null
            ? account.platform === "instagram"
              ? "Desconocidos (se conectó con el token del panel de Meta)"
              : "Desconocidos"
            : account.permissions.join(", ") || "Ninguno"}
        </dd>
      </dl>
      {account.status === "expired" && (
        <p className="mt-3 text-sm text-red-700">
          El acceso venció: reconecta la cuenta para volver a publicar.
        </p>
      )}
      {account.status === "error" && (
        <p className="mt-3 text-sm text-red-700">
          No se pudieron leer sus credenciales: reconecta la cuenta.
        </p>
      )}
      {account.status !== "revoked" &&
        (confirming ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>
              ¿Desconectar {account.displayName}? Sus publicaciones pendientes no saldrán hasta
              reconectarla.
            </span>
            <button
              type="button"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(account.id, { onSettled: () => setConfirming(false) })
              }
              className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {disconnect.isPending ? "Desconectando…" : "Sí, desconectar"}
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus onClick={cancel} className="underline">
              Cancelar
            </button>
          </div>
        ) : (
          <button
            ref={disconnectButton}
            type="button"
            onClick={ask}
            className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium"
          >
            Desconectar
          </button>
        ))}
      {disconnect.error && <ErrorAlert error={disconnect.error} />}
    </article>
  );
}
