import { manualConfirmCommands } from "@agentsales/core";
import { Link, useInRouterContext } from "react-router";
import { ApiError } from "../api/client.js";
import { CopyCommand } from "./accounts/CopyCommand.js";
import { errorText } from "./error-messages.js";
import {
  marketplaceIssuesHint,
  portalIssuesHint,
  ReadinessIssueList,
} from "./ReadinessIssueList.js";
import { Alert } from "./ui/Alert.js";
import { Button } from "./ui/Button.js";

/** Qué hacer ante los errores de la API que tienen arreglo del lado del operador. */
function hintFor(error: Error): string | null {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === "UNREACHABLE" || code === "TIMEOUT")
    return "El sistema no responde: vuelve a intentar en un momento (en el Mac, revisa que pnpm dev esté corriendo).";
  if (code === "DB_UNAVAILABLE")
    return "Neon puede estar despertando: vuelve a intentar en unos segundos.";
  if (code === "STORAGE_UNAVAILABLE")
    return "Revisa las variables R2_* y corre pnpm storage:check.";
  if (code === "QUEUE_UNAVAILABLE")
    return "La cola de trabajos no responde: vuelve a intentar en un momento (en el Mac, revisa que pnpm dev esté corriendo); lo que quedó en curso se retoma solo.";
  if (code === "PUBLISH_MODE_MISMATCH")
    return "La publicación y el sistema no están en el mismo modo (simulación o en vivo). No se cambió nada. Para hacerlo, el sistema tiene que estar en el modo de esta publicación.";
  if (code === "PORTAL_NOT_READY")
    return portalIssuesHint(error instanceof ApiError ? (error.issues ?? []) : []);
  if (code === "MARKETPLACE_NOT_READY")
    return marketplaceIssuesHint(error instanceof ApiError ? (error.issues ?? []) : []) || null;
  // Marketplace (spec F5 §4.3 y §4.7): primero se dice si la que espera salió o no.
  if (code === "MANUAL_CONFIRM_PENDING" || code === "MARKETPLACE_FORM_OPEN")
    return "Primero di si se publicó: en la tarjeta de Marketplace de esa propiedad (pega el enlace y marca Lo publiqué, o No lo publiqué) o con estos comandos. Si su formulario todavía se está llenando, espera a que quede listo.";
  if (code === "MARKETPLACE_DAILY_LIMIT")
    return "El límite cuenta los intentos en vivo de hoy (hora de Chile): sigue mañana.";
  if (code === "PUBLISHER_NOT_CONFIGURED")
    return "Revisa ML_APP_ID y ML_CLIENT_SECRET en el .env (pnpm -s cli doctor) y reinicia pnpm dev.";
  // F9-T21: las redes del post.
  if (code === "POST_HAS_PENDING_PUBLICATIONS")
    return "Cancélalas en Publicaciones, más abajo (o con agentsales publications cancel <id>), y vuelve a intentarlo.";
  if (code === "POST_PLATFORM_EXCLUDED")
    return "Agrega esa red al post con «Editar el post», o usa el texto de otra red.";
  if (code === "CLOSE_NOT_CONFIRMED")
    return "La página estaba desactualizada: recárgala y vuelve a cerrar.";
  return null;
}

/**
 * `PORTAL_NOT_READY` y `MARKETPLACE_NOT_READY` traen la lista de lo que falta (`issues`): se muestra
 * con un encabezado corto y no además el mensaje, que junta los mismos motivos (spec F4-T22).
 */
function IssueList({ error }: { error: Error }) {
  const code = error instanceof ApiError ? error.code : undefined;
  const issues = error instanceof ApiError ? (error.issues ?? []) : [];
  // Las `issues` de otros códigos (`BROKER_INVALID`: los campos de la marca) ya van en el mensaje.
  const readiness = code === "PORTAL_NOT_READY" || code === "MARKETPLACE_NOT_READY";
  if (issues.length === 0 || !readiness) {
    // En simple (F9.5-T20): el mensaje del mapa o el general, y el de la API debajo si aporta.
    const { title, detail } = errorText(error);
    return (
      <>
        <p className="font-semibold text-danger-800">{title}</p>
        {detail !== null && detail !== "" && <p className="mt-1 text-danger-800">{detail}</p>}
      </>
    );
  }
  const channel = code === "MARKETPLACE_NOT_READY" ? "Marketplace" : "Portal";
  return (
    <>
      <p className="font-semibold text-danger-800">Falta información para publicar en {channel}:</p>
      <ReadinessIssueList issues={issues} className="text-danger-800" />
    </>
  );
}

/** Los códigos que se arreglan en Cuentas: el aviso trae el enlace (F9.5-T20). */
const ACCOUNT_CODES = new Set(["ACCOUNT_NOT_CONNECTED", "ACCOUNT_REFRESH_UNSUPPORTED"]);

/** «Ir a Cuentas», con el router si lo hay (un aviso suelto en una prueba no lo tiene). */
function AccountsLink({ error }: { error: Error }) {
  const routed = useInRouterContext();
  if (!(error instanceof ApiError) || error.code === undefined || !ACCOUNT_CODES.has(error.code)) {
    return null;
  }
  const className = "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900";
  return (
    <p className="mt-1">
      {routed ? (
        <Link to="/cuentas" className={className}>
          Ir a Cuentas
        </Link>
      ) : (
        <a href="/cuentas" className={className}>
          Ir a Cuentas
        </a>
      )}
    </p>
  );
}

/**
 * `MANUAL_CONFIRM_PENDING` y `MARKETPLACE_FORM_OPEN` nombran la publicación de Marketplace con el
 * formulario abierto (`publicationId`, spec F5 §4.10): los dos comandos para cerrarla, como en la
 * CLI (`manualConfirmCommands`), porque puede ser de otra propiedad.
 */
function WaitingCommands({ error }: { error: Error }) {
  if (
    !(error instanceof ApiError) ||
    (error.code !== "MANUAL_CONFIRM_PENDING" && error.code !== "MARKETPLACE_FORM_OPEN") ||
    error.publicationId === undefined
  ) {
    return null;
  }
  const commands = manualConfirmCommands(error.publicationId);
  return (
    <div className="mt-2 text-danger-800">
      <p>Si la publicaste:</p>
      <CopyCommand command={commands.confirm} label="Copiar el comando de Lo publiqué" />
      <p className="mt-1">Si no:</p>
      <CopyCommand command={commands.notPublished} label="Copiar el comando de No lo publiqué" />
    </div>
  );
}

/**
 * Un error de la API, con su sugerencia y, si se puede, un botón para reintentar. `hint` reemplaza
 * la sugerencia por código cuando quien llama sabe más (un corte al operar un aviso de Portal).
 */
export function ErrorAlert({
  error,
  onRetry,
  retrying = false,
  hint: ownHint,
}: {
  error: Error;
  onRetry?: () => void;
  retrying?: boolean;
  hint?: string;
}) {
  const hint = ownHint ?? hintFor(error);
  const { code, title } = errorText(error);
  return (
    <Alert role="alert" tone="danger" className="mt-4">
      <IssueList error={error} />
      {hint && hint !== title && <p className="mt-1 text-danger-700">{hint}</p>}
      <WaitingCommands error={error} />
      <AccountsLink error={error} />
      {code !== null && <p className="mt-2 text-xs text-danger-700">código: {code}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying} className="mt-3">
          {retrying ? "Reintentando…" : "Reintentar"}
        </Button>
      )}
    </Alert>
  );
}
