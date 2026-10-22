import { chileInputValue, isAppError, type PublishMode, parseChileTime } from "@agentsales/core";
import { useId, useState } from "react";
import { useFreshPublishMode } from "../../queries/health.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";
import { needsLiveConfirm } from "./publications.js";

// F6-T12 (spec F6 §4.3): la hora de programar, en hora de Chile, con el modo a la vista.

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
      className="mt-3 space-y-3 rounded-lg border border-line bg-slate-50 p-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="font-medium text-fg">
          Fecha y hora (Chile)
        </label>
        <Input
          id={id}
          type="datetime-local"
          width="auto"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setConfirmLive(false);
          }}
          className="w-fit"
        />
      </div>
      {extra}
      <p className={mode === "live" ? "font-semibold text-danger-700" : "text-fg-muted"}>
        {modeLine(mode)}
      </p>
      {problem !== null && (
        <p role="alert" className="font-medium text-danger-700">
          {problem}
        </p>
      )}
      {confirmLive ? (
        <div role="alert" className="rounded-lg border border-danger-200 bg-danger-50 p-3">
          <p className="font-semibold text-danger-800">
            {mode === "live"
              ? "La API está en vivo: a la hora se publica de verdad, sin volver a preguntar."
              : "No se pudo saber si la API está en vivo: si lo está, a la hora se publica de verdad."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="danger" size="sm" disabled={pending} onClick={() => void submit(true)}>
              Sí, programar en vivo
            </Button>
            <Button variant="ghost" size="sm" autoFocus onClick={onCancel}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={pending}>
            {submitLabel}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      )}
    </form>
  );
}
