import type { HealthCheckName, HealthCheckResult, HealthReport } from "@agentsales/core";
import { HEALTH_CHECK_NAMES, workerStatusText } from "@agentsales/core";
import { useId } from "react";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useHealth } from "../queries/health.js";

const CHECKS: Record<HealthCheckName, { label: string; note?: string }> = {
  db: { label: "Base de datos", note: "Neon (Postgres)" },
  storage: { label: "Almacenamiento", note: "Cloudflare R2" },
  queue: { label: "Cola de trabajos", note: "Inicializada; el worker se ve abajo" },
};

const timeFormat = new Intl.DateTimeFormat("es-CL", {
  timeZone: "America/Santiago",
  timeStyle: "medium",
});

function CheckCard({ name, result }: { name: HealthCheckName; result: HealthCheckResult }) {
  const { label, note } = CHECKS[name];
  const titleId = useId();
  return (
    <li>
      <section
        aria-labelledby={titleId}
        className={`h-full rounded-lg border bg-white p-4 shadow-sm ${result.ok ? "border-slate-200" : "border-red-300"}`}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="font-semibold">
            {label}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              result.ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
            }`}
          >
            {result.ok ? "OK" : "Falla"}
          </span>
        </div>
        {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
        <p className="mt-3 text-sm text-slate-700">{result.latencyMs} ms</p>
        {!result.ok && result.error && (
          <p className="mt-2 break-words text-sm text-red-700">{result.error}</p>
        )}
      </section>
    </li>
  );
}

/** El worker según su latido (F8-T12): encendido desde…, apagado desde… o que no se sabe. */
function WorkerLine({ worker }: { worker: HealthReport["worker"] }) {
  if (worker === undefined) return null;
  const running = worker?.running === true;
  return (
    <p className="mt-4 text-sm text-slate-700">
      Worker:{" "}
      <strong className={running ? "text-emerald-700" : "text-amber-700"}>
        {workerStatusText(worker)}
      </strong>
      {!running && worker !== null && (
        <span className="text-slate-600">
          {" "}
          · sin él no se preparan ni se publican avisos, ni corre lo programado
        </span>
      )}
    </p>
  );
}

export function StatusPage() {
  const { data, error, isPending, isFetching, dataUpdatedAt, refetch } = useHealth({ poll: true });
  const checks = data?.checks;

  return (
    <section className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Estado del sistema</h1>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {isFetching ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {isPending && <p className="mt-6 text-slate-600">Consultando la API…</p>}

      {error && <ErrorAlert error={error} />}

      {data && (
        <>
          <p className="mt-4 text-sm text-slate-600">
            Estado general:{" "}
            <strong className={data.status === "ok" ? "text-emerald-700" : "text-amber-700"}>
              {data.status === "ok" ? "ok" : "degradado"}
            </strong>
            {data.version !== undefined && <> · API {data.version}</>}
            {" · "}actualizado {timeFormat.format(dataUpdatedAt)}
          </p>
          {checks === undefined ? (
            <p className="mt-4 text-sm text-slate-600">
              El detalle de cada servicio lo ve el administrador.
            </p>
          ) : (
            <>
              <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {HEALTH_CHECK_NAMES.map((name) => (
                  <CheckCard key={name} name={name} result={checks[name]} />
                ))}
              </ul>
              <WorkerLine worker={data.worker} />
            </>
          )}
        </>
      )}
    </section>
  );
}
