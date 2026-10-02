import { IMPORT_RUN_STATUS_TEXT, type ImportRunStatus } from "@agentsales/core";

const TONE: Readonly<Record<ImportRunStatus, string>> = {
  queued: "bg-amber-100 text-amber-800",
  running: "bg-sky-100 text-sky-800",
  succeeded: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
};

/** Estado de una carga, con "simulación" si es `--dry-run`. */
export function RunStatusBadge({ status, dryRun }: { status: ImportRunStatus; dryRun: boolean }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[status]}`}>
      {IMPORT_RUN_STATUS_TEXT[status]}
      {dryRun ? " (simulación)" : ""}
    </span>
  );
}
