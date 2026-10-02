import { IMPORT_WAIT, isTerminalImportRun } from "@agentsales/core";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { ImportReport } from "../components/ImportReport.js";
import { RunStatusBadge } from "../components/RunStatusBadge.js";
import { useImportRun } from "../queries/imports.js";

/**
 * Una carga: su progreso mientras corre (consulta cada 2 s), el aviso si sigue en cola a los 20 s
 * y, al terminar, el reporte por fila y columna (spec F1-T14).
 */
export function ImportRunPage() {
  const { id = "" } = useParams();
  const { run, stopped } = useImportRun(id);
  const notFound =
    run.error instanceof ApiError &&
    (run.error.code === "IMPORT_RUN_NOT_FOUND" || run.error.code === "REQUEST_INVALID");
  const data = run.data;
  // Se mide con la hora de cada respuesta, contra `createdAt`, que pone la base (Neon): el desfase
  // de reloj es despreciable frente a 20 s.
  const stuckInQueue =
    data?.status === "queued" &&
    run.dataUpdatedAt - data.createdAt.getTime() >= IMPORT_WAIT.queuedWarningMs;

  return (
    <section className="mx-auto max-w-4xl">
      <Link to="/importar" className="text-sm text-slate-600 underline">
        ← Importar
      </Link>
      {run.isPending && <p className="mt-3 text-slate-600">Cargando la carga…</p>}
      {notFound && (
        <p role="alert" className="mt-3 text-slate-700">
          Esta carga no existe.
        </p>
      )}
      {/* Con datos, una consulta fallida la cubre el aviso de "Dejé de consultar". */}
      {run.error && !notFound && !data && (
        <ErrorAlert
          error={run.error}
          onRetry={() => void run.refetch()}
          retrying={run.isFetching}
        />
      )}
      {data && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{data.input.xlsxFile}</h1>
            <RunStatusBadge status={data.status} dryRun={data.dryRun} />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {data.input.mediaFile ? `Medios: ${data.input.mediaFile}` : "Sin medios"}
            {data.input.broker ? ` · Corredor: ${data.input.broker}` : ""}
          </p>
          {data.dryRun && (
            <p className="mt-2 text-sm text-amber-700">
              Simulación: muestra lo que pasaría, sin guardar nada.
            </p>
          )}
          <div aria-live="polite">
            {!isTerminalImportRun(data.status) && (
              <p className="mt-4 text-slate-700">
                {data.status === "queued" ? "En cola…" : "Procesando el Excel y los medios…"}
              </p>
            )}
          </div>
          {stuckInQueue && !stopped && (
            <p role="alert" className="mt-2 text-sm text-amber-800">
              Sigue en cola: ¿está corriendo el worker? (pnpm dev)
            </p>
          )}
          {stopped && (
            <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="font-semibold text-amber-900">
                {stopped === "failures"
                  ? "Dejé de consultar: la API no respondió varias veces seguidas."
                  : "Dejé de consultar: la carga lleva más de 2 horas sin terminar."}
              </p>
              <p className="mt-1 text-sm text-amber-800">
                La carga sigue en el worker. Revisa que estén corriendo la API y el worker (pnpm
                dev).
              </p>
              <button
                type="button"
                onClick={() => void run.refetch()}
                disabled={run.isFetching}
                className="mt-3 rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {run.isFetching ? "Consultando…" : "Consultar de nuevo"}
              </button>
            </div>
          )}
          {data.error && (
            <ErrorAlert
              error={new ApiError(`${data.error.code}: ${data.error.message}`, data.error.code)}
            />
          )}
          <ImportReport run={data} />
          {data.status === "succeeded" && !data.dryRun && (
            <p className="mt-6">
              <Link to="/propiedades" className="font-medium underline">
                Ver las propiedades →
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
