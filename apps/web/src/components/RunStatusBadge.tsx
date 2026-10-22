import { IMPORT_RUN_STATUS_TEXT, type ImportRunStatus } from "@agentsales/core";
import { IMPORT_RUN_STATUS_TONE } from "../labels.js";
import { Badge } from "./ui/Badge.js";

/** Estado de una carga, con "simulación" si es `--dry-run`. */
export function RunStatusBadge({ status, dryRun }: { status: ImportRunStatus; dryRun: boolean }) {
  return (
    <Badge tone={IMPORT_RUN_STATUS_TONE[status]}>
      {IMPORT_RUN_STATUS_TEXT[status]}
      {dryRun ? " (simulación)" : ""}
    </Badge>
  );
}
