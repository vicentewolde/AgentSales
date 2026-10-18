import {
  hasExtension,
  MAX_XLSX_UPLOAD_BYTES,
  MEDIA_ZIP_EXTENSION,
  XLSX_EXTENSION,
} from "@agentsales/api/contracts";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { checkFolder, folderSelection, type UploadProgress } from "../api/upload.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { RunStatusBadge } from "../components/RunStatusBadge.js";
import { useBrokers } from "../queries/brokers.js";
import { useImportRuns, useStartImport } from "../queries/imports.js";
import { useRole } from "../scope/broker-scope.js";

const dateTime = new Intl.DateTimeFormat("es-CL", {
  timeZone: "America/Santiago",
  dateStyle: "medium",
  timeStyle: "short",
});

const fieldClass = "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";

/** Lo que se puede revisar sin subir nada: tipo y tamaño del Excel, tipo del zip. */
function checkFiles(file: File | undefined, media: File | undefined): string | null {
  if (!file) return "Elige el Excel con las propiedades.";
  if (!hasExtension(file.name, XLSX_EXTENSION)) return "El archivo debe ser un Excel (.xlsx).";
  if (file.size === 0) return "El Excel está vacío.";
  if (file.size > MAX_XLSX_UPLOAD_BYTES) {
    return `El Excel pasa de ${MAX_XLSX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  }
  if (media && !hasExtension(media.name, MEDIA_ZIP_EXTENSION)) {
    return "Las fotos y videos deben venir en un .zip o en una carpeta.";
  }
  return null;
}

const percent = (progress: UploadProgress) =>
  progress.totalBytes === 0 ? 0 : Math.round((progress.sentBytes / progress.totalBytes) * 100);

/** El avance de la subida a R2 (spec F8 §4.4), con un botón para cancelarla. */
function UploadStatus({ progress, onCancel }: { progress: UploadProgress; onCancel: () => void }) {
  const text =
    progress.phase === "hashing"
      ? "Preparando los archivos…"
      : progress.phase === "starting"
        ? "Archivos subidos: empezando la carga…"
        : `Subiendo ${progress.doneFiles} de ${progress.totalFiles} archivos (${percent(progress)} %)…`;
  return (
    <div aria-live="polite" className="space-y-2">
      <p className="text-sm text-slate-700">{text}</p>
      {progress.phase === "uploading" && (
        <progress
          aria-label="Avance de la subida"
          value={progress.sentBytes}
          max={Math.max(progress.totalBytes, 1)}
          className="w-full"
        />
      )}
      {progress.phase !== "starting" && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm"
        >
          Cancelar la subida
        </button>
      )}
    </div>
  );
}

/** `webkitdirectory` no está en los tipos de React: se pasa como atributo del DOM. */
const folderPicker = { webkitdirectory: "", directory: "" } as Record<string, string>;

function ImportForm() {
  const ids = {
    file: useId(),
    media: useId(),
    folder: useId(),
    broker: useId(),
    dryRun: useId(),
    mode: useId(),
  };
  const brokers = useBrokers();
  const role = useRole();
  const start = useStartImport();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<"zip" | "folder">("zip");
  const canceled = start.error instanceof DOMException && start.error.name === "AbortError";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { elements } = event.currentTarget;
    const filesOf = (name: string) => {
      const input = elements.namedItem(name);
      return input instanceof HTMLInputElement ? [...(input.files ?? [])] : [];
    };
    const file = filesOf("file")[0];
    // Un zip vacío (0 bytes) cuenta como no enviado; un Excel vacío se avisa.
    const chosenZip = mode === "zip" ? filesOf("media")[0] : undefined;
    const zip = chosenZip && chosenZip.size > 0 ? chosenZip : undefined;
    const folder = mode === "folder" ? folderSelection(filesOf("folder")) : null;
    const issue = checkFiles(file, zip) ?? (folder ? checkFolder(folder) : null);
    setProblem(issue);
    if (issue || !file) return;
    const broker = elements.namedItem("broker");
    const dryRun = elements.namedItem("dryRun");
    start.mutate(
      {
        file,
        media: zip ? { kind: "zip", file: zip } : folder,
        ...(broker instanceof HTMLSelectElement && broker.value ? { broker: broker.value } : {}),
        dryRun: dryRun instanceof HTMLInputElement && dryRun.checked,
      },
      { onSuccess: (run) => navigate(`/importar/${run.id}`) },
    );
  };

  return (
    <form
      aria-label="Nueva carga"
      onSubmit={onSubmit}
      className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.file} className="text-sm font-medium">
          Excel de propiedades (.xlsx)
        </label>
        <input id={ids.file} name="file" type="file" accept={XLSX_EXTENSION} className="text-sm" />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Fotos y videos (opcional)</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={ids.mode}
              checked={mode === "zip"}
              onChange={() => setMode("zip")}
            />
            Un .zip
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={ids.mode}
              checked={mode === "folder"}
              onChange={() => setMode("folder")}
            />
            Una carpeta
          </label>
        </div>
        {mode === "zip" ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.media} className="text-sm">
              Fotos y videos (.zip)
            </label>
            <input
              id={ids.media}
              name="media"
              type="file"
              accept={MEDIA_ZIP_EXTENSION}
              className="text-sm"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.folder} className="text-sm">
              Carpeta de fotos y videos
            </label>
            <input
              id={ids.folder}
              name="folder"
              type="file"
              multiple
              {...folderPicker}
              className="text-sm"
            />
          </div>
        )}
        <p className="text-xs text-slate-500">
          Una carpeta por propiedad, con el nombre de su id_propiedad o de carpeta_medios. Los
          archivos suben directo al almacenamiento, sin pasar por el servidor.
        </p>
      </fieldset>
      {/* Un corredor carga siempre lo suyo (F7, ADR-0022): sin selector. */}
      {role !== "broker" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.broker} className="text-sm font-medium">
            Corredor
          </label>
          <select id={ids.broker} name="broker" defaultValue="" className={fieldClass}>
            <option value="">Desde la hoja Corredor del Excel</option>
            {(brokers.data ?? []).map((broker) => (
              <option key={broker.id} value={broker.slug}>
                {broker.brandName} ({broker.slug})
              </option>
            ))}
          </select>
          {brokers.error && (
            <p className="text-xs text-amber-700">
              No se pudo cargar la lista de corredores; puedes importar igual con la hoja Corredor.
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input id={ids.dryRun} name="dryRun" type="checkbox" />
        <label htmlFor={ids.dryRun} className="text-sm">
          Solo simular: valida y muestra el reporte sin guardar nada
        </label>
      </div>
      <button
        type="submit"
        disabled={start.isPending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {start.isPending ? "Subiendo…" : "Importar"}
      </button>
      {start.isPending && start.progress && (
        <UploadStatus progress={start.progress} onCancel={start.cancel} />
      )}
      {problem && (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      )}
      {canceled && <p className="text-sm text-slate-700">Subida cancelada: no se cargó nada.</p>}
      {start.error && !canceled && <ErrorAlert error={start.error} />}
    </form>
  );
}

function History() {
  const runs = useImportRuns();
  return (
    <section aria-labelledby="historial" className="mt-8">
      <h2 id="historial" className="text-lg font-semibold">
        Cargas anteriores
      </h2>
      {runs.isPending && <p className="mt-2 text-sm text-slate-600">Cargando…</p>}
      {runs.error && (
        <ErrorAlert
          error={runs.error}
          onRetry={() => void runs.refetch()}
          retrying={runs.isFetching}
        />
      )}
      {runs.data?.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">Todavía no hay cargas.</p>
      )}
      {runs.data && runs.data.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-4">Fecha</th>
                <th className="py-1 pr-4">Archivo</th>
                <th className="py-1 pr-4">Estado</th>
                <th className="py-1">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.id} className="border-t border-slate-200">
                  <td className="py-1 pr-4">
                    <Link to={`/importar/${run.id}`} className="underline">
                      {dateTime.format(run.createdAt)}
                    </Link>
                  </td>
                  <td className="py-1 pr-4">{run.input.xlsxFile}</td>
                  <td className="py-1 pr-4">
                    <RunStatusBadge status={run.status} dryRun={run.dryRun} />
                  </td>
                  <td className="py-1">
                    {run.rowsCreated} creadas · {run.rowsUpdated} actualizadas · {run.rowsSkipped}{" "}
                    sin cambios · {run.rowsFailed} con error
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Importar: subir el Excel y los medios (un zip o una carpeta) directo a R2, y el historial de
 * cargas (spec F1-T14 y F8-T07).
 */
export function ImportPage() {
  return (
    <section className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Importar propiedades</h1>
      <ImportForm />
      <History />
    </section>
  );
}
