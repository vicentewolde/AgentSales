import type { AccountListResponse, PlatformAccountView } from "@agentsales/api/contracts";
import type { Broker } from "@agentsales/core";
import { type ReactNode, useId } from "react";
import { AccountCard } from "../components/accounts/AccountCard.js";
import { expiryState, visibleAccounts } from "../components/accounts/accounts.js";
import { ConnectBox } from "../components/accounts/ConnectBox.js";
import { MarketplaceConnectBox } from "../components/accounts/MarketplaceConnectBox.js";
import { MercadoLibreConnectBox } from "../components/accounts/MercadoLibreConnectBox.js";
import { OAuthReturn } from "../components/accounts/OAuthReturn.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useAccounts } from "../queries/accounts.js";
import { useBrokers } from "../queries/brokers.js";

/** Las cuentas de un canal del corredor y si hay que ofrecer conectar o reconectar. */
function channelState(accounts: readonly PlatformAccountView[], now: Date) {
  const shown = visibleAccounts(accounts);
  const connected = accounts.filter((account) => account.status === "connected");
  // Reconectar también si la conectada está por vencer o ya venció (spec F3 §4.9).
  const expiring = connected.some((account) => {
    const state = expiryState(account, now).kind;
    return state === "soon" || state === "expired";
  });
  return {
    shown,
    offerConnect: connected.length === 0 || expiring,
    reconnect: accounts.length > 0,
  };
}

/** Un canal del corredor: sus cuentas y, si hace falta, cómo conectarlo. */
function Channel({
  title,
  empty,
  accounts,
  now,
  children,
}: {
  title: string;
  empty: string;
  accounts: readonly PlatformAccountView[];
  now: Date;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-3">
      <h3 id={headingId} className="text-sm font-semibold text-slate-700">
        {title}
      </h3>
      {accounts.length === 0 && <p className="mt-1 text-sm text-slate-600">{empty}</p>}
      <div className="mt-2 flex flex-col gap-3">
        {accounts.map((account) => (
          <AccountCard key={account.id} account={account} now={now} />
        ))}
      </div>
      {children}
    </section>
  );
}

function BrokerAccounts({
  broker,
  data,
  now,
}: {
  broker: Broker;
  data: AccountListResponse;
  now: Date;
}) {
  const own = (platform: PlatformAccountView["platform"]) =>
    data.accounts.filter(
      (account) => account.brokerId === broker.id && account.platform === platform,
    );
  const instagram = channelState(own("instagram"), now);
  const mercadoLibre = channelState(own("portal_inmobiliario"), now);
  const marketplace = channelState(own("fb_marketplace"), now);
  const headingId = `corredor-${broker.id}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        {broker.brandName} <span className="text-sm text-slate-500">({broker.slug})</span>
      </h2>
      <Channel
        title="Instagram"
        empty="Sin cuenta de Instagram."
        accounts={instagram.shown}
        now={now}
      >
        {instagram.offerConnect && (
          <ConnectBox
            broker={broker}
            oauth={data.connect.instagram.oauth}
            startUrl={data.connect.instagram.startUrl}
            reconnect={instagram.reconnect}
          />
        )}
      </Channel>
      <Channel
        title="Mercado Libre (Portal Inmobiliario)"
        empty="Sin cuenta de Mercado Libre."
        accounts={mercadoLibre.shown}
        now={now}
      >
        {mercadoLibre.offerConnect && (
          <MercadoLibreConnectBox
            broker={broker}
            configured={data.connect.mercadolibre.configured}
            redirectUri={data.connect.mercadolibre.redirectUri}
            reconnect={mercadoLibre.reconnect}
          />
        )}
      </Channel>
      <Channel
        title="Facebook Marketplace"
        empty="Sin cuenta de Facebook."
        accounts={marketplace.shown}
        now={now}
      >
        {/* Siempre: sin vencimiento que avise, una sesión cerrada en Facebook no se ve hasta
            publicar, y la caja muestra el resultado de su espera. */}
        <MarketplaceConnectBox
          broker={broker}
          connected={!marketplace.offerConnect}
          reconnect={marketplace.reconnect}
        />
      </Channel>
    </section>
  );
}

/**
 * Página Cuentas (spec F3 §4.9 y, desde F4-T21, spec F4 §4.12; Marketplace desde F5-T12): por
 * corredor, su cuenta de Instagram, la de Mercado Libre y la de Facebook, conectar o reconectar y
 * desconectar. No sondea (salvo mientras espera un inicio de sesión de Marketplace): vuelve a pedir
 * las cuentas al volver a la pestaña (TanStack Query), lo que cubre una conexión hecha desde la CLI.
 */
export function AccountsPage() {
  const accounts = useAccounts();
  const brokers = useBrokers();
  const error = accounts.error ?? brokers.error;
  const now = new Date();
  const retry = () => {
    void accounts.refetch();
    void brokers.refetch();
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Cuentas</h1>
      <p className="mt-1 text-slate-600">
        Las cuentas de Instagram, Mercado Libre y Facebook de cada corredor. Se renuevan solas
        mientras el worker corre (pnpm dev): Instagram dura 60 días; Mercado Libre se da de baja
        tras 4 meses sin renovarse. Facebook no vence: si se cierra la sesión, vuelves a iniciarla.
      </p>
      <OAuthReturn />
      {error && (
        <ErrorAlert
          error={error}
          onRetry={retry}
          retrying={accounts.isFetching || brokers.isFetching}
        />
      )}
      {!error && (accounts.isPending || brokers.isPending) && (
        <p className="mt-6 text-slate-600">Cargando…</p>
      )}
      {accounts.data && brokers.data && brokers.data.length === 0 && (
        <p className="mt-6 text-slate-600">
          No hay corredores todavía: se crean al importar el Excel.
        </p>
      )}
      {accounts.data && brokers.data && (
        <div className="mt-6 flex flex-col gap-6">
          {brokers.data.map((broker) => (
            <BrokerAccounts key={broker.id} broker={broker} data={accounts.data} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
