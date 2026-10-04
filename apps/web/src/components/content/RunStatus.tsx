import type { ContentRunView } from "@agentsales/api/contracts";
import {
  CONTENT_RUN_STAGE_TEXT,
  CONTENT_RUN_STAGES,
  RUN_QUEUED_WARNING_TEXT,
} from "@agentsales/core";
import { type PollStop, stuckInQueue } from "../../queries/run-poll.js";
import { PollStoppedAlert } from "../PollStoppedAlert.js";
import { uniqueKeys } from "./keys.js";

/** Las etapas de una corrida, marcando las hechas y la que está en curso. */
function Stages({ run }: { run: ContentRunView }) {
  const stages = CONTENT_RUN_STAGES.filter((stage) => stage !== "texts" || run.texts);
  const current = run.stage === null ? -1 : stages.indexOf(run.stage);
  const mark = (index: number) => {
    if (run.status === "queued") return "pending";
    if (index < current) return "done";
    return index === current ? "current" : "pending";
  };
  return (
    <ol aria-label="Etapas" className="mt-2 space-y-1 text-sm">
      {stages.map((stage, index) => {
        const state = mark(index);
        return (
          <li
            key={stage}
            aria-current={state === "current" ? "step" : undefined}
            className={
              state === "done"
                ? "text-emerald-700"
                : state === "current"
                  ? "font-semibold text-slate-900"
                  : "text-slate-400"
            }
          >
            {state === "done" ? "✓ " : state === "current" ? "→ " : "· "}
            {CONTENT_RUN_STAGE_TEXT[stage]}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Una corrida en curso: sus etapas, el aviso si sigue en cola y si se dejó de consultar. El texto
 * del avance va en la región `aria-live` de la sección, que está siempre montada.
 */
export function RunProgress({
  run,
  checkedAt,
  stopped,
  onRetry,
  retrying,
}: {
  run: ContentRunView;
  checkedAt: number;
  stopped: PollStop | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <Stages run={run} />
      {stuckInQueue(run, checkedAt) && !stopped && (
        <p role="alert" className="mt-2 text-sm text-amber-800">
          {RUN_QUEUED_WARNING_TEXT}
        </p>
      )}
      {stopped && (
        <PollStoppedAlert
          stopped={stopped}
          noun="La preparación"
          onRetry={onRetry}
          retrying={retrying}
        />
      )}
    </div>
  );
}

/** El resultado de la última corrida: el error si falló y sus advertencias. */
export function RunResult({ run }: { run: ContentRunView }) {
  const warnings = run.report?.warnings ?? [];
  const keys = uniqueKeys(warnings, (warning) => warning);
  return (
    <>
      {run.status === "failed" && run.error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-800">La última preparación falló</p>
          <p className="mt-1 text-sm text-red-800">{run.error.message}</p>
          <p className="mt-1 text-xs text-red-700">Código: {run.error.code}</p>
        </div>
      )}
      {warnings.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-amber-800">
            Advertencias de la última preparación ({warnings.length})
          </summary>
          <ul className="mt-1 list-disc pl-5 text-amber-900">
            {warnings.map((warning, index) => (
              <li key={keys[index]}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
