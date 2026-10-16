import { chileInputValue, isAppError, type PublishMode, parseChileTime } from "@agentsales/core";
import { useId, useState } from "react";
import { useFreshPublishMode } from "../../queries/health.js";
import { needsLiveConfirm } from "./publications.js";

// F6-T12 (spec F6 §4.3): la hora de programar, en hora de Chile, con el modo a la vista.

const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
const DANGER =
  "rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

const HOUR_MS = 60 * 60 * 1000;

/** Una hora redonda por defecto: la primera en punto que esté al menos una hora adelante. */
export function defaultScheduleAt(now: Date = new Date()): Date {
  return new Date(Math.ceil((now.getTime() + HOUR_MS) / HOUR_MS) * HOUR_MS);
}

/** La hora inicial: la dada si todavía es futura (reprogramar); si no, `defaultScheduleAt`. */
export const initialScheduleAt = (initial: Date | null | undefined, now: Date = new Date()) =>
  initial != null && initial.getTime() > now.getTime() + HOUR_MS / 30
    ? initial
    : defaultScheduleAt(now);

/** El modo con que se programa, en palabras. */
const modeLine = (mode: PublishMode | undefined) =>
  mode === undefined
    ? "Todavía no se sabe si la API está en simulación o en vivo: se pedirá confirmar."
    : mode === "live"
      ? "Se programa en vivo: a la hora se publica de verdad (con el worker corriendo)."
      : "Se programa en simulación: a la hora sale sola con el worker corriendo, sin publicar de verdad.";

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
  const freshMode = useFreshPublishMode();
  const [value, setValue] = useState(chileInputValue(initialScheduleAt(initial)));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  // El modo que se muestra: el de la página, o el leído justo antes de enviar si cambió.
  const [mode, setMode] = useState<PublishMode | undefined>(publishMode);

  // Programar fija el modo de la API en ese momento (D11): como Publicar, en simulación se vuelve
  // a leer `/health` justo antes, por si la API cambió a vivo con la página abierta.
  const submit = async (confirmed: boolean) => {
    let at: Date;
    try {
      at = parseChileTime(value);
    } catch (error) {
      setProblem(isAppError(error) ? error.message : String(error));
      return;
    }
    setProblem(null);
    if (!confirmed) {
      const current = needsLiveConfirm(mode) ? mode : await freshMode().catch(() => undefined);
      setMode(current);
      if (needsLiveConfirm(current)) {
        setConfirmLive(true);
        return;
      }
    }
    setConfirmLive(false);
    onSubmit(at.toISOString());
  };

  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
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
      <p className={mode === "live" ? "font-semibold text-red-700" : "text-slate-600"}>
        {modeLine(mode)}
      </p>
      {problem !== null && (
        <p role="alert" className="text-red-700">
          {problem}
        </p>
      )}
      {confirmLive ? (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2">
          <p className="font-semibold text-red-800">
            {mode === "live"
              ? "La API está en vivo: a la hora se publica de verdad, sin volver a preguntar."
              : "No se pudo saber si la API está en vivo: si lo está, a la hora se publica de verdad."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={pending}
              onClick={() => void submit(true)}
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
