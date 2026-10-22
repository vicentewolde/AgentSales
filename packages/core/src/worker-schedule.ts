import { chileDateOf, formatChileTime, parseChileTime } from "./chile-time.js";

// El horario del worker (F9.5-T24, ADR-0037): el workflow `.github/workflows/worker-schedule.yml`
// enciende la máquina del worker unos minutos antes de cada ventana, y el worker se apaga solo
// cuando no le queda nada que hacer (`WORKER_IDLE_EXIT_MINUTES`). Lo programado entre ventanas sale
// cuando se vuelve a encender. La agenda y `doctor` usan estas horas para decir la próxima ventana.

/**
 * Las ventanas, en hora de Chile (`HH:MM`): la hora a la que sale lo programado. El workflow las
 * repite en su `WORKER_WINDOWS` y en sus `cron` (en UTC); un test del worker falla si no calzan.
 */
export const WORKER_WINDOWS = ["09:00", "17:00"] as const;

/** Cuántos minutos antes de cada ventana el workflow enciende el worker. */
export const WORKER_WINDOW_LEAD_MINUTES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * La próxima ventana después de `now` (el instante en que empieza), o `null` sin ventanas. Una hora
 * que no existe ese día en Chile (por el cambio de horario) se salta.
 */
export function nextWorkerWindow(
  now: Date,
  windows: readonly string[] = WORKER_WINDOWS,
): Date | null {
  const sorted = [...windows].sort();
  // Hoy, mañana y pasado: con al menos una hora válida, alguna cae ahí.
  for (let offset = 0; offset <= 2; offset += 1) {
    const day = chileDateOf(new Date(now.getTime() + offset * DAY_MS));
    for (const time of sorted) {
      let start: Date;
      try {
        start = parseChileTime(`${day} ${time}`);
      } catch {
        continue;
      }
      if (start.getTime() > now.getTime()) return start;
    }
  }
  return null;
}

/** Las ventanas en una frase: `09:00 y 17:00`. */
export function workerWindowsText(windows: readonly string[] = WORKER_WINDOWS): string {
  const sorted = [...windows].sort();
  if (sorted.length <= 1) return sorted.join("");
  return `${sorted.slice(0, -1).join(", ")} y ${sorted.at(-1)}`;
}

/** La próxima ventana en una frase, con la hora de Chile (`2026-10-22 17:00`), para `doctor` y la agenda. */
export function nextWorkerWindowText(
  now: Date,
  windows: readonly string[] = WORKER_WINDOWS,
): string {
  const next = nextWorkerWindow(now, windows);
  return next === null ? "sin ventanas" : formatChileTime(next);
}
