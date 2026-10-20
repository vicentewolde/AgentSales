import type { PlatformAccountView } from "@agentsales/api/contracts";
import {
  accountDisconnectText,
  currentMarketplaceLoginError,
  PLATFORM_ACCOUNT_STATUS_TEXT,
} from "@agentsales/core";
import { useRef, useState } from "react";
import { ACCOUNT_STATUS_TONE } from "../../labels.js";
import { useDisconnectAccount } from "../../queries/accounts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { AccountExpiry } from "./AccountExpiry.js";
import { accountDateText } from "./accounts.js";

/**
 * Marketplace (spec F5 §4.12): no hay token que venza ni se renueve; se muestra cuándo se vio la
 * sesión por última vez y, si falló un inicio de sesión después, el motivo.
 */
function MarketplaceDetails({ account }: { account: PlatformAccountView }) {
  const error = currentMarketplaceLoginError(account);
  return (
    <>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Sesión vista</dt>
        <dd>
          {account.sessionCheckedAt === null ? "—" : accountDateText(account.sessionCheckedAt)}
        </dd>
      </dl>
      {error !== null && (
        <p className="mt-3 text-sm text-red-700">
          El inicio de sesión del {accountDateText(error.at)} falló: {error.message}
        </p>
      )}
    </>
  );
}

/** Cuándo se renovó por última vez, o cómo se renueva si todavía no (F9-T19: las redes de posts). */
function renewalText(account: PlatformAccountView): string {
  if (account.tokenRefreshedAt !== null) return accountDateText(account.tokenRefreshedAt);
  switch (account.platform) {
    case "portal_inmobiliario":
      return "Todavía no (se renueva sola cada 7 días mientras el worker corre)";
    case "discord":
      return "No hace falta (un webhook no vence)";
    case "linkedin":
      return "No se renueva sola: reconéctala antes de que venza";
    case "x":
    case "tiktok":
      return "Todavía no (se renueva sola al publicar)";
    default:
      return "Todavía no (se renueva sola a las 24 h de conectarla)";
  }
}

/** Dólares en español de Chile: `US$10`, `US$2,5`. */
const usdText = (value: number) =>
  `US$${value.toLocaleString("es-CL", { maximumFractionDigits: 4 })}`;

/**
 * Una cuenta conectada (Instagram o Mercado Libre, desde F4-T21; Marketplace, desde F5-T12):
 * estado, vencimiento, renovación, permisos (en Marketplace, la sesión vista y el último inicio de
 * sesión fallido) y Desconectar con confirmación. El nombre va tal cual (Mercado Libre: el
 * `nickname`).
 */
export function AccountCard({
  account,
  now,
  manage = true,
  marketplaceAutomation,
}: {
  account: PlatformAccountView;
  now: Date;
  /** Desconectar es del administrador (F7, spec §4.5): el corredor ve la tarjeta sin el botón. */
  manage?: boolean;
  /** Si el ambiente permite el formulario automático (en producción no, F8-T20). */
  marketplaceAutomation: boolean;
}) {
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
      {account.platform === "fb_marketplace" ? (
        <MarketplaceDetails account={account} />
      ) : (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Vence</dt>
          <dd>
            <AccountExpiry account={account} now={now} />
          </dd>
          <dt className="text-slate-500">Última renovación</dt>
          <dd>{renewalText(account)}</dd>
          {account.publishingMode !== null && (
            <>
              <dt className="text-slate-500">Modo</dt>
              <dd>
                {account.publishingMode === "manual"
                  ? "A mano (deja el texto listo; publicas tú y pegas el enlace)"
                  : "Por la API"}
              </dd>
            </>
          )}
          {account.spendLimitUsd !== undefined && (
            <>
              <dt className="text-slate-500">Tope de gasto</dt>
              <dd>{usdText(account.spendLimitUsd)} al mes</dd>
            </>
          )}
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
      )}
      {/* Una cuenta de perfil que quedó de cuando se conectó en el Mac: en el servidor no se usa. */}
      {account.platform === "fb_marketplace" &&
        account.marketplaceMode === "profile" &&
        account.status === "connected" &&
        !marketplaceAutomation && (
          <p role="note" className="mt-3 text-sm text-amber-800">
            En el servidor Marketplace se publica a mano: esta cuenta de Facebook no se usa. Activa
            Marketplace a mano para este corredor.
          </p>
        )}
      {account.status === "expired" && (
        <p className="mt-3 text-sm text-red-700">
          {account.platform === "fb_marketplace"
            ? "La sesión de Facebook se cerró: vuelve a iniciar sesión para publicar."
            : "El acceso venció: reconecta la cuenta para volver a publicar."}
        </p>
      )}
      {account.status === "error" && (
        <p className="mt-3 text-sm text-red-700">
          La cuenta quedó con un error (sus credenciales no se pudieron leer o no sirven):
          reconéctala.
        </p>
      )}
      {manage &&
        account.status !== "revoked" &&
        (confirming ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>
              ¿Desconectar {account.displayName}?{" "}
              {accountDisconnectText(
                account.platform,
                account.marketplaceMode,
                marketplaceAutomation,
              )}
            </span>
            <button
              type="button"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(
                  // El operador contestó "Sí, desconectar" a la pregunta de arriba.
                  { accountId: account.id, confirmed: true },
                  { onSettled: () => setConfirming(false) },
                )
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
