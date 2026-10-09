import { ApiError } from "../api/client.js";

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
    return "Está publicada en vivo: reinicia la API en vivo (PUBLISH_MODE=live pnpm dev) si lo decides tú.";
  if (code === "PORTAL_NOT_READY")
    return "Complétalo en la planilla y vuelve a importarla; el WhatsApp es el de la hoja Corredor.";
  return null;
}

/**
 * `PORTAL_NOT_READY` trae la lista de lo que falta (`issues`): se muestra con un encabezado corto y
 * no además el mensaje, que junta los mismos motivos (spec F4-T22).
 */
function IssueList({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? (error.issues ?? []) : [];
  if (issues.length === 0) return <p className="font-semibold text-red-800">{error.message}</p>;
  return (
    <>
      <p className="font-semibold text-red-800">Falta información para publicar en Portal:</p>
      <ul className="mt-1 list-disc pl-5 text-sm text-red-800">
        {issues.map((issue) => (
          <li key={`${issue.code}-${issue.field ?? ""}-${issue.message}`}>
            {issue.message}
            {issue.field !== null && <span className="text-red-700"> ({issue.field})</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Un error de la API, con su sugerencia y, si se puede, un botón para reintentar. */
export function ErrorAlert({
  error,
  onRetry,
  retrying = false,
}: {
  error: Error;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const hint = hintFor(error);
  return (
    <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4">
      <IssueList error={error} />
      {hint && <p className="mt-1 text-sm text-red-700">{hint}</p>}
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
