import { manualConfirmCommands } from "@agentsales/core";
import { ApiError } from "../api/client.js";
import { CopyCommand } from "./accounts/CopyCommand.js";
import {
  marketplaceIssuesHint,
  portalIssuesHint,
  ReadinessIssueList,
} from "./ReadinessIssueList.js";

/** Qué hacer ante los errores de la API que tienen arreglo del lado del operador. */
function hintFor(error: Error): string | null {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === "UNREACHABLE" || code === "TIMEOUT")
    return "Levántala con pnpm dev y vuelve a intentar.";
  if (code === "DB_UNAVAILABLE")
    return "Neon puede estar despertando: vuelve a intentar en unos segundos.";
  if (code === "STORAGE_UNAVAILABLE")
    return "Revisa las variables R2_* y corre pnpm storage:check.";
  if (code === "QUEUE_UNAVAILABLE")
    return "Arranca el worker (pnpm dev): retoma lo que quedó en curso al arrancar.";
  if (code === "PUBLISH_MODE_MISMATCH")
    return "La publicación y la API no están en el mismo modo (simulación o en vivo): arranca la API en vivo (PUBLISH_MODE=live pnpm dev) solo si lo decides tú.";
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
  if (code === "CLOSE_NOT_CONFIRMED")
    return "La página estaba desactualizada: recárgala y vuelve a cerrar.";
  return null;
}

/**
 * `PORTAL_NOT_READY` y `MARKETPLACE_NOT_READY` traen la lista de lo que falta (`issues`): se muestra
 * con un encabezado corto y no además el mensaje, que junta los mismos motivos (spec F4-T22).
 */
function IssueList({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? (error.issues ?? []) : [];
  if (issues.length === 0) return <p className="font-semibold text-red-800">{error.message}</p>;
  const channel =
    error instanceof ApiError && error.code === "MARKETPLACE_NOT_READY" ? "Marketplace" : "Portal";
  return (
    <>
      <p className="font-semibold text-red-800">Falta información para publicar en {channel}:</p>
      <ReadinessIssueList issues={issues} className="text-red-800" />
    </>
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
    <div className="mt-2 text-sm text-red-800">
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
  return (
    <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4">
      <IssueList error={error} />
      {hint && <p className="mt-1 text-sm text-red-700">{hint}</p>}
      <WaitingCommands error={error} />
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-3 rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {retrying ? "Reintentando…" : "Reintentar"}
        </button>
      )}
    </div>
  );
}
