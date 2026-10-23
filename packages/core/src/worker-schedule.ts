import { formatChileTime } from "./chile-time.js";

// El horario del worker (F9.5-T24, ADR-0037): el workflow `.github/workflows/worker-schedule.yml`
// revisa cada hora, a los :50, y enciende la máquina del worker si está apagada, salvo de noche
// (fuera de la franja). El worker se apaga solo cuando no le queda nada que hacer ni nada que venza
// antes de la próxima revisión (`WORKER_STAY_AHEAD_MINUTES`). La agenda y `doctor` dicen cuándo es la
// próxima revisión con estas horas.

/** Cada cuánto revisa el workflow: una vez por hora (su `cron`). */
export const WORKER_CHECK_PERIOD_MINUTES = 60;

/** El minuto de cada hora en que el workflow revisa (en UTC, igual que en Chile: su desfase es de horas enteras). */
export const WORKER_CHECK_MINUTE = 50;

/**
 * Cuánto mira hacia adelante el worker antes de apagarse (`WORKER_STAY_AHEAD_MINUTES`, por defecto):
 * el periodo hasta la próxima revisión más 10 min por el atraso de GitHub. Menos que el periodo
 * dejaría lo que vence justo antes de la revisión siguiente esperando a esa revisión.
 */
export const WORKER_STAY_AHEAD_DEFAULT_MINUTES = WORKER_CHECK_PERIOD_MINUTES + 10;

/**
 * La franja del día en que el workflow enciende el worker, en hora de Chile (`HH:MM`): desde la
 * revisión que llega `WORKER_CHECK_LEAD_MINUTES` antes de `from` hasta la última antes de `until`
 * (con 07:00 y 23:00, de 06:50 a 22:50). El workflow repite estas horas en su `env`; un test del
 * worker falla si no calzan.
 */
export const WORKER_ACTIVE_HOURS = { from: "07:00", until: "23:00" } as const;

/** Cuántos minutos antes de `from` llega la primera revisión del día (06:50 para las 07:00). */
export const WORKER_CHECK_LEAD_MINUTES = WORKER_CHECK_PERIOD_MINUTES - WORKER_CHECK_MINUTE;

/**
 * Holgura después de `until` para una revisión atrasada por GitHub (la de las 22:50 que corre a las
 * 23:10 todavía enciende); la revisión siguiente a su hora (23:50) queda fuera.
 */
export const WORKER_CHECK_GRACE_MINUTES = 15;

const HOUR_MS = WORKER_CHECK_PERIOD_MINUTES * 60 * 1000;

const minutesOf = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

/**
 * Si una revisión que corre a esa hora de Chile (minutos del día) enciende el worker: desde
 * `WORKER_CHECK_LEAD_MINUTES` antes de `from` hasta `WORKER_CHECK_GRACE_MINUTES` después de `until`
 * (sin incluir). El paso «¿Toca encenderlo?» del workflow hace la misma cuenta; un test los compara.
 */
export function isWorkerCheckTime(
  chileMinutes: number,
  hours: { from: string; until: string } = WORKER_ACTIVE_HOURS,
): boolean {
  return (
    chileMinutes >= minutesOf(hours.from) - WORKER_CHECK_LEAD_MINUTES &&
    chileMinutes < minutesOf(hours.until) + WORKER_CHECK_GRACE_MINUTES
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
  // La última revisión :50 que enciende (con la holgura).
  const lastHour = Math.floor(
    (minutesOf(hours.until) + WORKER_CHECK_GRACE_MINUTES - 1 - WORKER_CHECK_MINUTE) / 60,
  );
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
