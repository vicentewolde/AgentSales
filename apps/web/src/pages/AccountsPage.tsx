import type { AccountListResponse, PlatformAccountView } from "@agentsales/api/contracts";
import {
  accountOwnedBy,
  type Broker,
  brokerHoldsListings,
  marketplaceAutomationAllowed,
  type PublishMode,
} from "@agentsales/core";
import { type ReactNode, useId } from "react";
import { AccountCard } from "../components/accounts/AccountCard.js";
import { AutoPublishToggle } from "../components/accounts/AutoPublishToggle.js";
import { expiryState, visibleAccounts } from "../components/accounts/accounts.js";
import { ConnectBox } from "../components/accounts/ConnectBox.js";
import { MarketplaceConnectBox } from "../components/accounts/MarketplaceConnectBox.js";
import { MarketplaceManualBox } from "../components/accounts/MarketplaceManualBox.js";
import { MercadoLibreConnectBox } from "../components/accounts/MercadoLibreConnectBox.js";
import { OAuthReturn } from "../components/accounts/OAuthReturn.js";
import { DiscordConnectBox, OAuthConnectBox } from "../components/accounts/SocialConnectBox.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useAccounts } from "../queries/accounts.js";
import { useBrokers } from "../queries/brokers.js";
import { useHealth } from "../queries/health.js";
import { useBrokerFilter, useCan } from "../scope/broker-scope.js";

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
  manage,
  connect = manage,
  marketplaceAutomation,
  children,
}: {
  title: string;
  empty: string;
  accounts: readonly PlatformAccountView[];
  now: Date;
  /** Solo el administrador conecta, renueva y desconecta (F7, spec §4.5). */
  manage: boolean;
  /** Si ve cómo conectar el canal: el administrador, y el corredor su Instagram (ADR-0028). */
  connect?: boolean;
  /** Si el ambiente permite el formulario automático de Marketplace (F8-T20). */
  marketplaceAutomation: boolean;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-3">
      <h3 id={headingId} className="text-sm font-semibold text-fg">
        {title}
      </h3>
      {accounts.length === 0 && (
        <p className="mt-1 text-sm text-fg-muted">
          {empty}
          {!connect && " Pídele al administrador que la conecte."}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-3">
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            now={now}
            manage={manage}
            marketplaceAutomation={marketplaceAutomation}
          />
        ))}
      </div>
      {connect && children}
    </section>
  );
}

function BrokerAccounts({
  broker,
  data,
  now,
  publishMode,
  manage,
}: {
  broker: Broker;
  data: AccountListResponse;
  now: Date;
  publishMode: PublishMode | undefined;
  manage: boolean;
}) {
  const own = (platform: PlatformAccountView["platform"]) =>
    data.accounts.filter(
      (account) => accountOwnedBy(account, broker.id) && account.platform === platform,
    );
  const instagram = channelState(own("instagram"), now);
  const mercadoLibre = channelState(own("portal_inmobiliario"), now);
  const marketplace = channelState(own("fb_marketplace"), now);
  // F9-T19: las redes del contenido de marca (cualquier corredor o marca publica posts).
  const discord = channelState(own("discord"), now);
  const linkedin = channelState(own("linkedin"), now);
  const x = channelState(own("x"), now);
  const tiktok = channelState(own("tiktok"), now);
  const settings = useCan("broker.settings", broker.id);
  // El corredor conecta su propio Instagram, solo con el inicio de sesión de Instagram (ADR-0028).
  const connectInstagram = useCan("instagram.connect", broker.id);
  // Y su LinkedIn, X y TikTok con el OAuth de cada una (F9-T15, T16 y T26).
  const connectLinkedIn = useCan("linkedin.connect", broker.id);
  const connectX = useCan("x.connect", broker.id);
  const connectTikTok = useCan("tiktok.connect", broker.id);
  const manualActive = own("fb_marketplace").some(
    (account) => account.status === "connected" && account.marketplaceMode === "manual",
  );
  // En el servidor el formulario automático no corre: todos publican a mano (F8-T20, D4).
  const automation = data.connect.marketplace.automation;
  // Una marca (F9, ADR-0029) no tiene propiedades: sin Portal, Marketplace ni publicación automática.
  const listings = brokerHoldsListings(broker);
  // Cada tipo ve las redes que le sirven (F9.5-T20): el corredor de propiedades, Instagram, Mercado
  // Libre y Marketplace; la marca, Instagram, X, LinkedIn, Discord y TikTok. Una cuenta de una red de
  // marca que ya estaba en un corredor se sigue viendo (para desconectarla), pero sin ofrecer conectar.
  const brand = !listings;
  const social = (state: ReturnType<typeof channelState>) => brand || state.shown.length > 0;
  const headingId = `corredor-${broker.id}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        {broker.brandName} <span className="text-sm text-fg-subtle">({broker.slug})</span>
      </h2>
      {settings && listings && <AutoPublishToggle broker={broker} publishMode={publishMode} />}
      <Channel
        title="Instagram"
        empty="Sin cuenta de Instagram."
        accounts={instagram.shown}
        now={now}
        manage={manage}
        connect={manage || (connectInstagram && data.connect.instagram.oauth)}
        marketplaceAutomation={automation}
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
      {listings && (
        <>
          <Channel
            title="Mercado Libre (Portal Inmobiliario)"
            empty="Sin cuenta de Mercado Libre."
            accounts={mercadoLibre.shown}
            now={now}
            manage={manage}
            marketplaceAutomation={automation}
          >
            {mercadoLibre.offerConnect && (
              <MercadoLibreConnectBox
                broker={broker}
                configured={data.connect.mercadolibre.configured}
                redirectUri={data.connect.mercadolibre.redirectUri}
                automatic={data.connect.mercadolibre.automatic}
                reconnect={mercadoLibre.reconnect}
              />
            )}
          </Channel>
          <Channel
            title="Facebook Marketplace"
            empty="Sin cuenta de Facebook."
            accounts={marketplace.shown}
            now={now}
            manage={manage}
            marketplaceAutomation={automation}
          >
            {/* El perfil del navegador solo para un corredor propio (ADR-0023); siempre, porque sin
            vencimiento que avise una sesión cerrada no se ve hasta publicar. */}
            {marketplaceAutomationAllowed(broker, automation) && !manualActive && (
              <MarketplaceConnectBox
                broker={broker}
                connected={!marketplace.offerConnect}
                reconnect={marketplace.reconnect}
              />
            )}
            <MarketplaceManualBox
              broker={broker}
              active={manualActive}
              automation={automation}
              replacesProfile={own("fb_marketplace").some(
                (account) =>
                  account.status === "connected" && account.marketplaceMode === "profile",
              )}
            />
          </Channel>
        </>
      )}
      {social(discord) && (
        <Channel
          title="Discord"
          empty="Sin webhook de Discord."
          accounts={discord.shown}
          now={now}
          manage={manage}
          connect={brand && manage}
          marketplaceAutomation={automation}
        >
          {discord.offerConnect && (
            <DiscordConnectBox broker={broker} reconnect={discord.reconnect} />
          )}
        </Channel>
      )}
      {social(linkedin) && (
        <Channel
          title="LinkedIn"
          empty="Sin perfil de LinkedIn."
          accounts={linkedin.shown}
          now={now}
          manage={manage}
          connect={brand && (manage || connectLinkedIn)}
          marketplaceAutomation={automation}
        >
          {linkedin.offerConnect && (
            <OAuthConnectBox
              broker={broker}
              network="linkedin"
              configured={data.connect.linkedin.configured}
              startUrl={data.connect.linkedin.startUrl}
              reconnect={linkedin.reconnect}
            />
          )}
        </Channel>
      )}
      {social(x) && (
        <Channel
          title="X"
          empty="Sin cuenta de X."
          accounts={x.shown}
          now={now}
          manage={manage}
          connect={brand && (manage || connectX)}
          marketplaceAutomation={automation}
        >
          {x.offerConnect && (
            <OAuthConnectBox
              broker={broker}
              network="x"
              configured={data.connect.x.configured}
              startUrl={data.connect.x.startUrl}
              reconnect={x.reconnect}
            />
          )}
        </Channel>
      )}
      {social(tiktok) && (
        <Channel
          title="TikTok"
          empty="Sin cuenta de TikTok."
          accounts={tiktok.shown}
          now={now}
          manage={manage}
          connect={brand && (manage || connectTikTok)}
          marketplaceAutomation={automation}
        >
          {tiktok.offerConnect && (
            <OAuthConnectBox
              broker={broker}
              network="tiktok"
              configured={data.connect.tiktok.configured}
              startUrl={data.connect.tiktok.startUrl}
              reconnect={tiktok.reconnect}
            />
          )}
        </Channel>
      )}
    </section>
  );
}

/**
 * Página Cuentas (spec F3 §4.9 y, desde F4-T21, spec F4 §4.12; Marketplace desde F5-T12): por
 * corredor, su cuenta de Instagram, la de Mercado Libre y la de Facebook (desde F9-T19, también
 * Discord, LinkedIn, X y TikTok), conectar o reconectar y desconectar. No sondea (salvo mientras espera un inicio de sesión de Marketplace): vuelve a pedir
 * las cuentas al volver a la pestaña (TanStack Query), lo que cubre una conexión hecha desde la CLI.
 */
export function AccountsPage() {
  // El corredor del selector (F7-T17) y lo que el corredor no ve (conectar, renovar, desconectar).
  const broker = useBrokerFilter();
  // Quién conecta y la publicación automática (`can` de core, spec F7 §4.5), por corredor abajo.
  const manage = useCan("accounts.manage");
  const accounts = useAccounts(broker);
  const brokers = useBrokers();
  const shownBrokers = (brokers.data ?? []).filter(
    (item) => broker === undefined || item.slug === broker,
  );
  const health = useHealth();
  const error = accounts.error ?? brokers.error;
  const now = new Date();
  const retry = () => {
    void accounts.refetch();
    void brokers.refetch();
  };

  return (
    <div>
      <PageHeader
        title="Cuentas"
        description={
          <>
            Las cuentas de cada corredor o marca: Instagram, Mercado Libre y Facebook para un
            corredor de propiedades, e Instagram, X, LinkedIn, Discord y TikTok para una marca. Se
            renuevan solas mientras el worker está encendido: Instagram dura 60 días; Mercado Libre
            se da de baja tras 4 meses sin renovarse; X y TikTok se renuevan al publicar. Facebook y
            Discord no vencen; LinkedIn dura 60 días y se reconecta antes de que venza (la agenda
            avisa).
          </>
        }
      />
      <OAuthReturn />
      {error && (
        <ErrorAlert
          error={error}
          onRetry={retry}
          retrying={accounts.isFetching || brokers.isFetching}
        />
      )}
      {!error && (accounts.isPending || brokers.isPending) && (
        <p className="mt-6 text-fg-muted">Cargando…</p>
      )}
      {accounts.data && brokers.data && brokers.data.length === 0 && (
        <p className="mt-6 text-fg-muted">
          No hay corredores todavía: créalos en Corredores o al importar el Excel.
        </p>
      )}
      {accounts.data && brokers.data && (
        <div className="mt-6 flex flex-col gap-6">
          {shownBrokers.map((item) => (
            <BrokerAccounts
              key={item.id}
              broker={item}
              data={accounts.data}
              now={now}
              publishMode={health.data?.publishMode}
              manage={manage}
            />
          ))}
        </div>
      )}
    </div>
  );
}
