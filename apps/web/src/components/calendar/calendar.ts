import { chileDateOf, chileDateStart } from "@agentsales/core";

// El calendario del panel (F9-T18): los días que se muestran y su rango, en hora de Chile. Un día
// es `"AAAA-MM-DD"` de Chile; la semana empieza el lunes. La aritmética de días va en UTC (sin
// horas: el cambio de horario no la toca) y solo el borde de cada día pasa por `chileDateStart`.

export const CALENDAR_VIEWS = ["semana", "mes"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const utcOf = (day: string): Date => {
  const match = DAY.exec(day);
  if (match === null) throw new RangeError(`El día debe ser "AAAA-MM-DD": "${day}"`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
};

const dayOfUtc = (date: Date): string => date.toISOString().slice(0, 10);

/** Un día válido (`"2026-10-19"`, que exista en el calendario) o `undefined`. */
export function validDay(text: string | null): string | undefined {
  if (text === null || !DAY.test(text)) return undefined;
  return dayOfUtc(utcOf(text)) === text ? text : undefined;
}

/** El día `n` días después (o antes, con `n` negativo). */
export const addDays = (day: string, n: number): string => {
  const date = utcOf(day);
  date.setUTCDate(date.getUTCDate() + n);
  return dayOfUtc(date);
};

/** El lugar del día en su semana: lunes 0 … domingo 6. */
export const weekdayIndex = (day: string): number => (utcOf(day).getUTCDay() + 6) % 7;

/** El lunes de la semana del día. */
export const startOfWeek = (day: string): string => addDays(day, -weekdayIndex(day));

/** El primer día del mes del día, movido `n` meses. */
export const firstOfMonth = (day: string, n = 0): string => {
  const date = utcOf(`${day.slice(0, 8)}01`);
  date.setUTCMonth(date.getUTCMonth() + n);
  return dayOfUtc(date);
};

/**
 * Los días a la vista: la semana del día (lunes a domingo) o las semanas completas que cubren su
 * mes (de 4 a 6, como mucho 42 días).
 */
export function visibleDays(view: CalendarView, anchor: string): string[] {
  const start = view === "semana" ? startOfWeek(anchor) : startOfWeek(firstOfMonth(anchor));
  const end =
    view === "semana"
      ? addDays(start, 6)
      : addDays(startOfWeek(addDays(firstOfMonth(anchor, 1), -1)), 6);
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * El rango de instantes `[from, to)` de los días a la vista: desde el comienzo del primero hasta el
 * del día siguiente al último, cada uno en hora de Chile (`chileDateStart`).
 */
export function rangeOfDays(days: readonly string[]): { from: Date; to: Date } {
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) throw new RangeError("Sin días");
  return { from: chileDateStart(first), to: chileDateStart(addDays(last, 1)) };
}

/** El día de referencia de la semana o el mes anterior (`step = -1`) o siguiente (`1`). */
export const shiftAnchor = (view: CalendarView, anchor: string, step: 1 | -1): string =>
  view === "semana" ? addDays(startOfWeek(anchor), 7 * step) : firstOfMonth(anchor, step);

/** Las entradas agrupadas por su día de Chile, en el orden recibido (la API las ordena por hora). */
export function byChileDay<T extends { at: Date }>(entries: readonly T[]): Map<string, T[]> {
  const days = new Map<string, T[]>();
  for (const entry of entries) {
    const day = chileDateOf(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return days;
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

const parts = (day: string) => {
  const date = utcOf(day);
  return {
    year: date.getUTCFullYear(),
    month: MONTHS[date.getUTCMonth()] ?? "",
    date: date.getUTCDate(),
  };
};

/** `lunes 19 de octubre`. */
export function dayLabel(day: string): string {
  const { month, date } = parts(day);
  return `${WEEKDAYS[weekdayIndex(day)]} ${date} de ${month}`;
}

/** `Octubre de 2026` o `Semana del 19 al 25 de octubre de 2026` (o entre dos meses o años). */
export function periodLabel(view: CalendarView, anchor: string): string {
  if (view === "mes") {
    const { month, year } = parts(anchor);
    return `${month.charAt(0).toUpperCase()}${month.slice(1)} de ${year}`;
  }
  const start = parts(startOfWeek(anchor));
  const end = parts(addDays(startOfWeek(anchor), 6));
  const from =
    start.year !== end.year
      ? `${start.date} de ${start.month} de ${start.year}`
      : start.month !== end.month
        ? `${start.date} de ${start.month}`
        : `${start.date}`;
  return `Semana del ${from} al ${end.date} de ${end.month} de ${end.year}`;
}
