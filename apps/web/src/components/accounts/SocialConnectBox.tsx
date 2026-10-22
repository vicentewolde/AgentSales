import type { Broker } from "@agentsales/core";
import { buttonClasses } from "../ui/styles.js";
import { CopyCommand } from "./CopyCommand.js";

/** Las redes de contenido de marca que se conectan con su OAuth en el navegador (F9-T19). */
export type OAuthNetwork = "linkedin" | "x" | "tiktok";

const NETWORK: Readonly<
  Record<OAuthNetwork, { name: string; env: string; guide: string; note: string }>
> = {
  linkedin: {
    name: "LinkedIn",
    env: "LINKEDIN_CLIENT_ID y LINKEDIN_CLIENT_SECRET",
    guide: "docs/integraciones/linkedin.md",
    note: "Queda a mano: AgentSales deja el texto listo y tú publicas y pegas el enlace. El acceso dura 60 días.",
  },
  x: {
    name: "X",
    env: "X_CLIENT_ID y X_CLIENT_SECRET",
    guide: "docs/integraciones/x.md",
    note: "Cada post cuesta créditos de X: el tope del mes se fija con accounts spend-limit (por defecto US$10).",
  },
  tiktok: {
    name: "TikTok",
    env: "TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET",
    guide: "docs/integraciones/tiktok.md",
    note: "El video llega como borrador a la app de TikTok: lo publicas tú y pegas el enlace.",
  },
};

/**
 * Conectar (o reconectar) LinkedIn, X o TikTok de un corredor o marca (F9-T19): el enlace al inicio
 * del OAuth que da la API (`connect.<red>.startUrl`, en el host de su dirección de retorno), con
 * `?broker=<slug>`, como el de Instagram. El inicio usa la sesión del panel de ese host (la cookie
 * no mira el puerto): si el panel está abierto en otro (en el Mac, `localhost` frente a
 * `127.0.0.1`, que X exige), lo dice. Sin el par de la app en la API, dice qué anotar en el `.env`
 * en vez del enlace.
 */
export function OAuthConnectBox({
  broker,
  network,
  configured,
  startUrl,
  reconnect,
  hostname = window.location.hostname,
}: {
  broker: Broker;
  network: OAuthNetwork;
  configured: boolean;
  startUrl: string;
  reconnect: boolean;
  /** El host del panel (los tests lo pasan). */
  hostname?: string;
}) {
  const { name, env, guide, note } = NETWORK[network];
  const label = `${reconnect ? "Reconectar" : "Conectar"} ${name}`;
  if (!configured) {
    return (
      <div className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-warning-800">
          A la API le faltan {env} en el .env: agrégalos y reiníciala para conectar {name} ({guide}
          ).
        </p>
      </div>
    );
  }
  const start = new URL(startUrl);
  return (
    <div className="mt-3 text-sm">
      <a
        href={`${startUrl}?broker=${encodeURIComponent(broker.slug)}`}
        aria-label={`${label} de ${broker.brandName}`}
        className={buttonClasses("primary", "sm")}
      >
        {label}
      </a>
      <p className="mt-1 text-fg-muted">{note}</p>
      {start.hostname !== hostname && (
        <p role="note" className="mt-1 text-warning-800">
          La conexión empieza en {start.hostname}: abre el panel en esa dirección (con tu sesión) y
          conecta desde ahí.
        </p>
      )}
    </div>
  );
}

/** El comando que conecta el webhook de Discord (la URL va por la entrada estándar, nunca aquí). */
export const discordConnectCommand = (slug: string) =>
  `pbpaste | pnpm -s cli accounts connect discord --broker ${slug} --webhook-stdin`;

/**
 * Discord (F9-T14, F9-T19): la URL del webhook es el secreto del canal, así que no se pega en el
 * panel: se conecta desde la terminal, leyéndola del portapapeles.
 */
export function DiscordConnectBox({ broker, reconnect }: { broker: Broker; reconnect: boolean }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-slate-50 p-3 text-sm">
      <p className="font-medium">{reconnect ? "Reconectar Discord" : "Conectar Discord"}</p>
      <p className="mt-1 text-fg-muted">
        La URL del webhook es secreta: se conecta desde la terminal, sin pegarla aquí.
      </p>
      <ol className="mt-1 list-decimal pl-5 text-fg-muted">
        <li>
          En Discord: Ajustes del servidor, Integraciones, Webhooks, Nuevo webhook (elige el canal)
          y Copiar URL del webhook.
        </li>
        <li>En la terminal, con la API corriendo, pega y corre este comando:</li>
      </ol>
      <CopyCommand
        command={discordConnectCommand(broker.slug)}
        label={`Copiar el comando de Discord de ${broker.slug}`}
      />
    </div>
  );
}
