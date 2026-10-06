import { AccountCard } from "../components/accounts/AccountCard.js";
import { expiryState, visibleAccounts } from "../components/accounts/accounts.js";
import { ConnectBox } from "../components/accounts/ConnectBox.js";
import { OAuthReturn } from "../components/accounts/OAuthReturn.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useAccounts } from "../queries/accounts.js";
import { useBrokers } from "../queries/brokers.js";

/**
 * Página Cuentas (spec F3 §4.9): por corredor, su cuenta de Instagram, conectar o reconectar y
 * desconectar. No sondea: vuelve a pedir las cuentas al volver a la pestaña (TanStack Query), lo que
 * cubre una conexión hecha desde la CLI.
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
        La cuenta de Instagram de cada corredor. El acceso dura 60 días y se renueva solo mientras
        el worker corre.
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
          {brokers.data.map((broker) => {
            const own = accounts.data.accounts.filter(
              (account) => account.brokerId === broker.id && account.platform === "instagram",
            );
            const shown = visibleAccounts(own);
            const connected = own.filter((account) => account.status === "connected");
            // Reconectar también si la conectada está por vencer o ya venció (spec F3 §4.9).
            const expiring = connected.some((account) => {
              const state = expiryState(account, now).kind;
              return state === "soon" || state === "expired";
            });
            const headingId = `corredor-${broker.id}`;
            return (
              <section key={broker.id} aria-labelledby={headingId}>
                <h2 id={headingId} className="text-lg font-semibold">
                  {broker.brandName} <span className="text-sm text-slate-500">({broker.slug})</span>
                </h2>
                {shown.length === 0 && (
                  <p className="mt-2 text-sm text-slate-600">Sin cuenta de Instagram.</p>
                )}
                <div className="mt-2 flex flex-col gap-3">
                  {shown.map((account) => (
                    <AccountCard key={account.id} account={account} now={now} />
                  ))}
                </div>
                {(connected.length === 0 || expiring) && (
                  <ConnectBox
                    broker={broker}
                    oauth={accounts.data.connect.instagram.oauth}
                    startUrl={accounts.data.connect.instagram.startUrl}
                    reconnect={own.length > 0}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
