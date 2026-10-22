import type { ImportRunView } from "@agentsales/api/contracts";
import {
  IMPORT_BROKER_OUTCOME_TEXT,
  IMPORT_ROW_OUTCOME_TEXT,
  importReportIssues,
} from "@agentsales/core";
import { Link } from "react-router";

type Report = NonNullable<ImportRunView["report"]>;

function Counts({ run }: { run: ImportRunView }) {
  const media = run.report?.media;
  const items = [
    ["Creadas", run.rowsCreated],
    ["Actualizadas", run.rowsUpdated],
    ["Sin cambios", run.rowsSkipped],
    ["Con error", run.rowsFailed],
  ] as const;
  return (
    <>
      {run.dryRun && (
        <p className="mt-4 text-xs font-medium text-warning-700">
          Simulación: estos números son lo que habría pasado; no se guardó nada.
        </p>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-3 shadow-xs">
            <dt className="text-xs font-medium text-fg-subtle">{label}</dt>
            <dd
              className={`text-2xl font-semibold ${label === "Con error" && value > 0 ? "text-danger-700" : ""}`}
            >
              {value}
            </dd>
          </div>
        ))}
        <div className="col-span-2 rounded-xl border border-line bg-surface p-3 sm:col-span-4 shadow-xs">
          <dt className="text-xs font-medium text-fg-subtle">Fotos y videos</dt>
          {/* `media` falta si la carga no llegó a la ingesta: no se asumen ceros. */}
          <dd className="text-sm">
            {media
              ? `subidos ${media.filesUploaded} · ya estaban ${media.filesExisting} · omitidos ${media.filesSkipped} · con error ${media.filesFailed}`
              : "—"}
          </dd>
        </div>
      </dl>
    </>
  );
}

function HeaderNotes({ headers }: { headers: Report["headers"] }) {
  if (headers === null) return null;
  const notes = [
    headers.missing.length > 0 && {
      tone: "text-danger-700",
      text: `Faltan columnas: ${headers.missing.join(", ")}`,
    },
    headers.unknown.length > 0 && {
      tone: "text-warning-700",
      text: `Columnas desconocidas (se guardan aparte): ${headers.unknown.join(", ")}`,
    },
    headers.duplicated.length > 0 && {
      tone: "text-warning-700",
      text: `Columnas repetidas: ${headers.duplicated.join(", ")}`,
    },
  ].filter((note): note is { tone: string; text: string } => Boolean(note));
  if (notes.length === 0) return null;
  return (
    <ul className="mt-4 space-y-1 text-sm">
      {notes.map((note) => (
        <li key={note.text} className={note.tone}>
          {note.text}
        </li>
      ))}
    </ul>
  );
}

/** Errores por fila y columna, con los de la hoja Corredor primero (spec F1 §4.4). */
function ErrorsTable({ report }: { report: Report }) {
  const rows = importReportIssues(report).errors.map((issue) => ({
    row: issue.rowNumber === null ? "Corredor" : String(issue.rowNumber),
    ref: issue.externalRef ?? "—",
    column: issue.column,
    message: issue.message,
  }));
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="errores" className="mt-6">
      <h2 id="errores" className="text-lg font-semibold text-danger-800">
        Errores ({rows.length})
      </h2>
      <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
        <table className="ui-table">
          <thead className="text-xs text-fg-subtle">
            <tr>
              <th>Fila</th>
              <th>Propiedad</th>
              <th>Columna</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: una fila puede repetir columna y motivo.
                key={index}
              >
                <td>{row.row}</td>
                <td>{row.ref}</td>
                <td>{row.column}</td>
                <td>{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Qué pasó con cada fila, con enlace a la propiedad guardada. */
function RowsTable({ report }: { report: Report }) {
  const rows = report.rows.filter((row) => row.outcome !== "ignored");
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="filas" className="mt-6">
      <h2 id="filas" className="text-lg font-semibold">
        Filas ({rows.length})
      </h2>
      <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
        <table className="ui-table">
          <thead className="text-xs text-fg-subtle">
            <tr>
              <th>Fila</th>
              <th>Propiedad</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowNumber}>
                <td>{row.rowNumber}</td>
                <td>
                  {row.listingId ? (
                    <Link
                      to={`/propiedades/${row.listingId}`}
                      className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
                    >
                      {row.externalRef ?? "—"}
                    </Link>
                  ) : (
                    (row.externalRef ?? "—")
                  )}
                </td>
                <td className={`${row.outcome === "failed" ? "text-danger-700" : ""}`}>
                  {IMPORT_ROW_OUTCOME_TEXT[row.outcome]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Warnings({ report }: { report: Report }) {
  const { warnings } = importReportIssues(report);
  if (warnings.length === 0) return null;
  return (
    <section aria-labelledby="advertencias" className="mt-6">
      <h2 id="advertencias" className="text-lg font-semibold text-warning-800">
        Advertencias ({warnings.length})
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {warnings.map((warning, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: dos archivos pueden dar la misma advertencia.
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </section>
  );
}

/** El reporte de una carga: contadores, corredor, columnas, filas, errores y advertencias. */
export function ImportReport({ run }: { run: ImportRunView }) {
  const { report } = run;
  if (report === null) return null;
  return (
    <>
      <Counts run={run} />
      {report.broker && (
        <p className="mt-3 text-sm text-fg-muted">
          Corredor: {report.broker.slug ?? "—"} ({IMPORT_BROKER_OUTCOME_TEXT[report.broker.outcome]}
          )
        </p>
      )}
      <HeaderNotes headers={report.headers} />
      <ErrorsTable report={report} />
      <RowsTable report={report} />
      <Warnings report={report} />
    </>
  );
}
