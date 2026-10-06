import {
  OAUTH_REDIRECT_ERRORS,
  type OAuthRedirectError,
  type PlatformAccountView,
} from "@agentsales/api/contracts";
import { type Broker, PLATFORM_ACCOUNT_STATUS_TEXT } from "@agentsales/core";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { ACCOUNT_STATUS_TONE } from "../labels.js";
import { useAccounts, useDisconnectAccount } from "../queries/accounts.js";
import { useBrokers } from "../queries/brokers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Con 10 días o menos de vigencia, se avisa (spec F3 §4.6). */
const EXPIRY_WARNING_DAYS = 10;

/** Por qué el OAuth volvió con `?error=` (los códigos del contrato y los de Instagram). */
const OAUTH_ERROR_TEXT: Readonly<Record<OAuthRedirectError, string>> = {
  OAUTH_DENIED: "Rechazaste los permisos en Instagram: no se conectó nada.",
  OAUTH_STATE_INVALID:
    "El enlace de conexión venció o se abrió desde otra pestaña: vuelve a conectar.",
  OAUTH_CODE_MISSING: "Instagram no devolvió el código de conexión: vuelve a conectar.",
  INSTAGRAM_NOT_CONFIGURED:
    "A la API le faltan INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET en el .env: agrégalos y reiníciala.",
  BROKER_NOT_FOUND: "El corredor del enlace no existe: vuelve a conectar desde esta página.",
  INTERNAL_ERROR: "La conexión falló por un error interno: revisa el log de la API.",
};

const INSTAGRAM_ERROR_TEXT: Readonly<Record<string, string>> = {
  IG_PERMISSION_DENIED:
    "No diste el permiso de publicar: vuelve a conectar y acepta todos los permisos.",
  IG_AUTH_INVALID:
    "Instagram no aceptó la conexión (el código venció o ya se usó): vuelve a conectar.",
  IG_UNAVAILABLE: "Instagram no respondió: vuelve a intentarlo en unos minutos.",
};

const isOAuthError = (code: string): code is OAuthRedirectError =>
  (OAUTH_REDIRECT_ERRORS as readonly string[]).includes(code);

/** El texto de un `?error=` de la URL: un código que no conocemos no se muestra tal cual. */
function oauthErrorText(code: string): string {
  if (isOAuthError(code)) return OAUTH_ERROR_TEXT[code];
  const known = INSTAGRAM_ERROR_TEXT[code];
  if (known !== undefined) return known;
  return /^[A-Z_]{1,64}$/.test(code)
    ? `No se pudo conectar Instagram (${code}).`
    : "No se pudo conectar Instagram.";
}

const dateText = (date: Date) =>
  date.toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" });

/** El mensaje con que vuelve el OAuth (`?conectada=instagram` o `?error=<código>`), con Cerrar. */
function OAuthReturn() {
  const [params, setParams] = useSearchParams();
  const connected = params.get("conectada");
  const error = params.get("error");
  if (connected === null && error === null) return null;
  const close = () => setParams({}, { replace: true });
  const ok = error === null;
  return (
    <div
      role={ok ? "status" : "alert"}
      className={`mt-4 flex items-start justify-between gap-4 rounded-lg border p-4 ${
        ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
      }`}
    >
      <p className={ok ? "text-emerald-800" : "text-red-800"}>
        {ok ? "Cuenta de Instagram conectada." : oauthErrorText(error)}
      </p>
      <button type="button" onClick={close} className="text-sm underline">
        Cerrar
      </button>
    </div>
  );
}

/** Vencimiento con su aviso: vencido en rojo; con 10 días o menos, en ámbar. */
function Expiry({ account }: { account: PlatformAccountView }) {
  if (account.tokenExpiresAt === null) return <span>Sin fecha</span>;
  const estimated = account.tokenExpiryEstimated ? " (estimado)" : "";
  const text = `${dateText(account.tokenExpiresAt)}${estimated}`;
  if (account.status !== "connected") return <span>{text}</span>;
  const days = Math.ceil((account.tokenExpiresAt.getTime() - Date.now()) / DAY_MS);
  if (days <= 0) {
    return <span className="font-semibold text-red-700">{text} · venció: reconéctala</span>;
  }
  if (days <= EXPIRY_WARNING_DAYS) {
    return (
      <span className="font-semibold text-amber-700">
        {text} · vence en {days} {days === 1 ? "día" : "días"}
      </span>
    );
  }
  return <span>{text}</span>;
}

function AccountCard({ account }: { account: PlatformAccountView }) {
  const disconnect = useDisconnectAccount();
  const [confirming, setConfirming] = useState(false);
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
          <Expiry account={account} />
        </dd>
        <dt className="text-slate-500">Última renovación</dt>
        <dd>
          {account.tokenRefreshedAt === null
            ? "Todavía no (se renueva sola a las 24 h de conectarla)"
            : dateText(account.tokenRefreshedAt)}
        </dd>
        <dt className="text-slate-500">Tipo</dt>
        <dd>{account.accountType ?? "—"}</dd>
        <dt className="text-slate-500">Permisos</dt>
        <dd>
          {account.permissions === null
            ? "Desconocidos (se conectó con el token del panel de Meta)"
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
            <button type="button" onClick={() => setConfirming(false)} className="underline">
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium"
          >
            Desconectar
          </button>
        ))}
      {disconnect.error && <ErrorAlert error={disconnect.error} />}
    </article>
  );
}

/**
 * Cómo conectar (o reconectar) la cuenta de un corredor: el botón del OAuth solo con `https` (F7);
 * en F3 (D4), el comando de la CLI con el token del panel de Meta, para copiar.
 */
function ConnectBox({
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
  const [copied, setCopied] = useState(false);
  const label = reconnect ? "Reconectar Instagram" : "Conectar Instagram";
  if (oauth) {
    // Directo a la API (no por el proxy `/api`): la cookie del `state` va en su host.
    return (
      <a
        href={`${startUrl}?broker=${encodeURIComponent(broker.slug)}`}
        className="mt-3 inline-block rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
      >
        {label}
      </a>
    );
  }
  const command = `pbpaste | pnpm -s cli accounts connect instagram --broker ${broker.slug} --token-stdin`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-slate-600">
        Meta no acepta la conexión desde localhost: copia el token del botón Generate token (panel
        de Meta, Instagram API setup) y corre en la terminal:
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-white px-2 py-1 text-xs break-all">{command}</code>
        <button type="button" onClick={() => void copy()} className="text-xs underline">
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
    </div>
  );
}

/** Las cuentas que se muestran: las que no están desconectadas o, si no hay, la última desconectada. */
function visibleAccounts(accounts: readonly PlatformAccountView[]): PlatformAccountView[] {
  const active = accounts.filter((account) => account.status !== "revoked");
  if (active.length > 0) return active;
  const last = accounts.at(-1);
  return last === undefined ? [] : [last];
}

/** Página Cuentas (spec F3 §4.9): por corredor, su cuenta de Instagram, conectar y desconectar. */
export function AccountsPage() {
  const accounts = useAccounts();
  const brokers = useBrokers();
  const error = accounts.error ?? brokers.error;
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
            const connected = own.some((account) => account.status === "connected");
            return (
              <section key={broker.id} aria-label={`Corredor ${broker.slug}`}>
                <h2 className="text-lg font-semibold">
                  {broker.brandName} <span className="text-sm text-slate-500">({broker.slug})</span>
                </h2>
                {shown.length === 0 && (
                  <p className="mt-2 text-sm text-slate-600">Sin cuenta de Instagram.</p>
                )}
                <div className="mt-2 flex flex-col gap-3">
                  {shown.map((account) => (
                    <AccountCard key={account.id} account={account} />
                  ))}
                </div>
                {!connected && (
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
