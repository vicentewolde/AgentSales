import type { HealthCheckName, HealthCheckResult } from "@agentsales/core";
import { HEALTH_CHECK_NAMES } from "@agentsales/core";
import { useId } from "react";
import { useHealth } from "../health.js";

const CHECKS: Record<HealthCheckName, { label: string; note?: string }> = {
  db: { label: "Base de datos", note: "Neon (Postgres)" },
  storage: { label: "Almacenamiento", note: "Cloudflare R2" },
  queue: { label: "Cola de trabajos", note: "Inicializada; no indica si el worker está corriendo" },
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

export function StatusPage() {
  const { data, error, isPending, isFetching, dataUpdatedAt, refetch } = useHealth({ poll: true });

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

      {error && (
        <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-800">{error.message}</p>
          <p className="mt-1 text-sm text-red-700">Levántala con pnpm dev y vuelve a intentar.</p>
        </div>
      )}

      {data && (
        <>
          <p className="mt-4 text-sm text-slate-600">
            Estado general:{" "}
            <strong className={data.status === "ok" ? "text-emerald-700" : "text-amber-700"}>
              {data.status === "ok" ? "ok" : "degradado"}
            </strong>
            {" · "}API {data.version}
            {" · "}actualizado {timeFormat.format(dataUpdatedAt)}
          </p>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {HEALTH_CHECK_NAMES.map((name) => (
              <CheckCard key={name} name={name} result={data.checks[name]} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
