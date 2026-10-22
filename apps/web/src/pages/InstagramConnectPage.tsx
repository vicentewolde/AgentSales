import { useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { ButtonLink } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { buttonClasses } from "../components/ui/styles.js";
import { useAccounts } from "../queries/accounts.js";
import { useBrokers } from "../queries/brokers.js";

/**
 * Antes de Conectar Instagram (F9.5-T20): una pantalla en español que explica qué se va a
 * autorizar, que la cuenta debe ser profesional y que, mientras Meta no apruebe la app, solo
 * funciona con cuentas agregadas como evaluadoras. «Continuar a Instagram» sigue el flujo de
 * siempre: el inicio del OAuth que da la API, con el corredor (`?broker=<slug>`). La pantalla que
 * sigue es de Instagram y está en inglés.
 */
export function InstagramConnectPage() {
  const [params] = useSearchParams();
  const slug = params.get("broker");
  const accounts = useAccounts();
  const brokers = useBrokers();
  const error = accounts.error ?? brokers.error;
  const broker = (brokers.data ?? []).find((item) => item.slug === slug);
  const instagram = accounts.data?.connect.instagram;
  const back = { to: "/cuentas", label: "Cuentas" };

  if (error) {
    return (
      <div>
        <PageHeader title="Conectar Instagram" back={back} />
        <ErrorAlert
          error={error}
          onRetry={() => {
            void accounts.refetch();
            void brokers.refetch();
          }}
        />
      </div>
    );
  }
  if (accounts.data === undefined || brokers.data === undefined) {
    return (
      <div>
        <PageHeader title="Conectar Instagram" back={back} />
        <p className="text-fg-muted">Cargando…</p>
      </div>
    );
  }
  if (broker === undefined || instagram === undefined || !instagram.oauth) {
    return (
      <div>
        <PageHeader title="Conectar Instagram" back={back} />
        <p className="text-fg-muted">
          {broker === undefined
            ? "No encontramos ese corredor: vuelve a Cuentas y elige Conectar Instagram desde su tarjeta."
            : "Instagram se conecta de otra forma en este ambiente: vuelve a Cuentas y sigue los pasos de la tarjeta."}
        </p>
        <ButtonLink to="/cuentas" className="mt-4">
          Volver a Cuentas
        </ButtonLink>
      </div>
    );
  }
  return (
    <div>
      <PageHeader
        title="Conectar Instagram"
        description={`Vas a conectar la cuenta de Instagram de ${broker.brandName}. Antes de seguir, esto es lo que conviene saber.`}
        back={back}
      />
      <Card as="section" title="Qué vas a autorizar" className="mb-4">
        <p className="text-sm text-fg">
          Instagram te va a pedir permiso para que AgentSales pueda{" "}
          <strong>publicar en la cuenta</strong> (fotos, carruseles y reels) y{" "}
          <strong>leer las métricas básicas</strong> de la cuenta. Nada más.
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          AgentSales nunca ve ni guarda tu contraseña: la escribes solo en Instagram. Puedes quitar
          el permiso cuando quieras desde la configuración de la cuenta.
        </p>
      </Card>
      <Card as="section" title="La cuenta tiene que ser profesional" className="mb-4">
        <p className="text-sm text-fg">
          Instagram solo deja publicar desde fuera con una cuenta{" "}
          <strong>de empresa o de creador</strong>. Si es personal, cámbiala antes en la app de
          Instagram (Configuración, Tipo de cuenta y herramientas): es gratis y se puede deshacer.
        </p>
      </Card>
      <Card as="section" title="Mientras Meta no apruebe la app" className="mb-4">
        <p className="text-sm text-fg">
          Mientras Meta no apruebe la app, solo funcionan las cuentas que el administrador haya
          agregado como <strong>evaluadoras</strong>. Si la cuenta no lo es, Instagram va a rechazar
          la conexión: pídele al administrador que la agregue.
        </p>
      </Card>
      <Card as="section" title="La pantalla que sigue" className="mb-4">
        <p className="text-sm text-fg">
          Al continuar pasas a una pantalla de <strong>Instagram, en inglés</strong>. Inicia sesión
          si te lo pide y aprieta <strong>Allow</strong> (Permitir) para aceptar. Después vuelves
          solo a Cuentas.
        </p>
      </Card>
      <div className="flex flex-wrap gap-3">
        <a
          href={`${instagram.startUrl}?broker=${encodeURIComponent(broker.slug)}`}
          className={buttonClasses("primary", "md")}
        >
          Continuar a Instagram
        </a>
        <ButtonLink to="/cuentas">Cancelar</ButtonLink>
      </div>
    </div>
  );
}
