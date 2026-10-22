import { formatChileTime } from "./chile-time.js";

// El horario del worker (F9.5-T24, ADR-0037): el workflow `.github/workflows/worker-schedule.yml`
// revisa cada hora, a los :50, y enciende la máquina del worker si está apagada, salvo de noche
// (fuera de la franja). El worker se apaga solo cuando no le queda nada que hacer ni nada que venza
// antes de la próxima revisión (`WORKER_STAY_AHEAD_MINUTES`). La agenda y `doctor` dicen cuándo es la
// próxima revisión con estas horas.

/** El minuto de cada hora en que el workflow revisa (en UTC, igual que en Chile: su desfase es de horas enteras). */
export const WORKER_CHECK_MINUTE = 50;

/**
 * La franja del día en que el workflow enciende el worker, en hora de Chile (`HH:MM`): desde la
 * revisión que llega `WORKER_CHECK_LEAD_MINUTES` antes de `from` hasta la última antes de `until`
 * (con 07:00 y 23:00, de 06:50 a 22:50). El workflow repite estas horas en su `env`; un test del
 * worker falla si no calzan.
 */
export const WORKER_ACTIVE_HOURS = { from: "07:00", until: "23:00" } as const;

/** Cuántos minutos antes de `from` llega la primera revisión del día (06:50 para las 07:00). */
export const WORKER_CHECK_LEAD_MINUTES = 10;

const HOUR_MS = 60 * 60 * 1000;

const minutesOf = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

/** Si una revisión a esa hora de Chile (minutos del día) cae dentro de la franja. */
export function isWorkerCheckTime(
  chileMinutes: number,
  hours: { from: string; until: string } = WORKER_ACTIVE_HOURS,
): boolean {
  return (
    chileMinutes >= minutesOf(hours.from) - WORKER_CHECK_LEAD_MINUTES &&
    chileMinutes < minutesOf(hours.until)
  );
}

/**
 * La próxima revisión del workflow después de `now` (la próxima hora :50 dentro de la franja), o
 * `null` si la franja no tiene ninguna. GitHub puede atrasarla unos minutos, nunca adelantarla.
 */
export function nextWorkerCheck(
  now: Date,
  hours: { from: string; until: string } = WORKER_ACTIVE_HOURS,
): Date | null {
  let at = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + WORKER_CHECK_MINUTE * 60_000;
  if (at <= now.getTime()) at += HOUR_MS;
  // Dos días alcanzan para cualquier franja con alguna revisión.
  for (let step = 0; step < 48; step += 1, at += HOUR_MS) {
    const time = formatChileTime(new Date(at)).slice(11);
    if (isWorkerCheckTime(minutesOf(time), hours)) return new Date(at);
  }
  return null;
}

/** El horario en una frase: `cada hora a los :50, de 06:50 a 22:50, hora de Chile`. */
export function workerScheduleText(
  hours: { from: string; until: string } = WORKER_ACTIVE_HOURS,
): string {
  const first = minutesOf(hours.from) - WORKER_CHECK_LEAD_MINUTES;
  // La última revisión :50 antes de `until`.
  const lastHour = Math.floor((minutesOf(hours.until) - 1 - WORKER_CHECK_MINUTE) / 60);
  const hhmm = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `cada hora a los :${WORKER_CHECK_MINUTE}, de ${hhmm(first)} a ${hhmm(lastHour * 60 + WORKER_CHECK_MINUTE)}, hora de Chile`;
}

/** La próxima revisión en una frase, con la hora de Chile (`2026-10-22 16:50`), para `doctor` y la agenda. */
export function nextWorkerCheckText(
  now: Date,
  hours: { from: string; until: string } = WORKER_ACTIVE_HOURS,
): string {
  const next = nextWorkerCheck(now, hours);
  return next === null ? "sin revisiones" : formatChileTime(next);
}
