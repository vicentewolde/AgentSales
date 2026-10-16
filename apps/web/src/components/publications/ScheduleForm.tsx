import {
  chileInputValue,
  isAppError,
  type PublishMode,
  parseChileTime,
  publicationModeText,
} from "@agentsales/core";
import { useId, useState } from "react";
import { needsLiveConfirm } from "./publications.js";

// F6-T12 (spec F6 §4.3): la hora de programar, en hora de Chile, con el modo a la vista.

const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
const DANGER =
  "rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

/** Una hora redonda por defecto: la próxima en punto, al menos una hora adelante. */
export function defaultScheduleAt(now: Date = new Date()): Date {
  const next = new Date(now.getTime() + 60 * 60 * 1000);
  next.setUTCMinutes(0, 0, 0);
  return next;
}

/**
 * El selector de fecha y hora (Chile) de programar (`<input type="datetime-local">`, leído con
 * `parseChileTime`): muestra si queda en simulación o en vivo y, en vivo (o si no se sabe el modo),
 * pide confirmar antes de enviar. Devuelve la hora en ISO con zona.
 */
export function ScheduleForm({
  publishMode,
  initial,
  pending,
  submitLabel,
  extra,
  onSubmit,
  onCancel,
}: {
  publishMode: PublishMode | undefined;
  initial?: Date | null;
  pending: boolean;
  submitLabel: string;
  /** Campos propios de quien lo usa (canales y espaciado del lote). */
  extra?: React.ReactNode;
  onSubmit: (at: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(chileInputValue(initial ?? defaultScheduleAt()));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const live = needsLiveConfirm(publishMode);

  const submit = (confirmed: boolean) => {
    let at: Date;
    try {
      at = parseChileTime(value);
    } catch (error) {
      setProblem(isAppError(error) ? error.message : String(error));
      return;
    }
    setProblem(null);
    if (live && !confirmed) {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    onSubmit(at.toISOString());
  };

  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="font-medium text-slate-700">
          Fecha y hora (Chile)
        </label>
        <input
          id={id}
          type="datetime-local"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setConfirmLive(false);
          }}
          className="w-fit rounded-md border border-slate-300 bg-white px-2 py-1"
        />
      </div>
      {extra}
      <p className={publishMode === "live" ? "font-semibold text-red-700" : "text-slate-600"}>
        {publishMode === undefined
          ? "Todavía no se sabe si la API está en simulación o en vivo: se pedirá confirmar."
          : `Se programa en ${publicationModeText(publishMode === "dry-run")}: a la hora sale sola con el worker corriendo.`}
      </p>
      {problem !== null && (
        <p role="alert" className="text-red-700">
          {problem}
        </p>
      )}
      {confirmLive ? (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2">
          <p className="font-semibold text-red-800">
            La API está en vivo: a la hora se publica de verdad, sin volver a preguntar.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={pending}
              onClick={() => submit(true)}
            >
              Sí, programar en vivo
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
            <button type="button" autoFocus className="underline" onClick={onCancel}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={PRIMARY} disabled={pending}>
            {submitLabel}
          </button>
          <button type="button" className="underline" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      )}
    </form>
  );
}
