import { AppError } from "./errors.js";

// La hora de Chile (spec F6 §4.3), para la CLI y el panel: el operador escribe "2026-10-19 10:00"
// (o el selector del panel da "2026-10-19T10:00") y la API
// recibe la hora con zona. Con el cambio de horario, una hora puede no existir (cuando se adelanta
// el reloj) o repetirse (cuando se atrasa): la primera se rechaza; la segunda toma la primera vez.

export const CHILE_TIME_ZONE = "America/Santiago";

const INPUT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/;

const parts = (date: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CHILE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

/** `2026-10-19 10:00` (hora de Chile) de un instante. */
export function formatChileTime(date: Date): string {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Cuántos minutos va Chile respecto de UTC en ese instante (−180 o −240). */
function offsetMinutes(date: Date): number {
  const p = parts(date);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
  );
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/**
 * `"2026-10-19 10:00"` (o `"2026-10-19T10:00"`, el del selector del panel) en hora de Chile → el
 * instante. `SCHEDULE_AT_INVALID` (400) si no tiene esa forma o si la hora no existe en Chile por el
 * cambio de horario.
 */
export function parseChileTime(text: string): Date {
  const formatError = () =>
    new AppError(
      "SCHEDULE_AT_INVALID",
      `La hora debe ser "AAAA-MM-DD HH:MM" en hora de Chile (por ejemplo "2026-10-19 10:00"): "${text}"`,
    );
  const match = INPUT.exec(text.trim());
  if (match === null) throw formatError();
  const [, year = 0, month = 1, day = 1, hour = 0, minute = 0] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Una fecha u hora inventada (30 de febrero, 25:00) se desbordaría a otro día: es un error de forma.
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    throw formatError();
  }
  // Los dos desplazamientos posibles (invierno y verano): la primera vez que esa hora existe.
  const candidates = [...new Set([-240, -180].map((offset) => wall - offset * 60_000))]
    .map((ms) => new Date(ms))
    .filter((date) => offsetMinutes(date) * 60_000 === wall - date.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  const found = candidates[0];
  if (found === undefined || formatChileTime(found) !== formatParts(match)) {
    throw new AppError(
      "SCHEDULE_AT_INVALID",
      `Las ${text.trim().replace("T", " ")} no existen en Chile: ese día se adelanta el reloj (elige otra hora)`,
    );
  }
  return found;
}

const formatParts = (match: RegExpExecArray) =>
  `${match[1]}-${match[2]}-${match[3]} ${String(match[4]).padStart(2, "0")}:${match[5]}`;

/** `2026-10-19T10:00` (hora de Chile), el valor de un `<input type="datetime-local">`. */
export const chileInputValue = (date: Date): string => formatChileTime(date).replace(" ", "T");

/** El primer instante de un día en Chile (si las 00:00 no existen por el cambio de horario, la 01:00). */
function chileDayStart(year: number, month: number, day: number): Date {
  const target = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const wall = Date.UTC(year, month - 1, day);
  // Chile va 3 o 4 horas detrás de UTC: el día empieza entre las 03:00 y las 05:00 UTC.
  for (let ms = wall + 2 * 3_600_000; ms <= wall + 6 * 3_600_000; ms += 30 * 60_000) {
    if (formatChileTime(new Date(ms)).startsWith(target)) return new Date(ms);
  }
  throw new RangeError(`No se encontró el inicio del ${target} en Chile`);
}

const MONTH = /^(\d{4})-(\d{2})$/;

/**
 * El mes calendario de Chile (`"2026-10"`) como rango de instantes `[from, to)` (spec F7 §4.7: el
 * gasto del mes). `MONTH_INVALID` (400) si no tiene esa forma.
 */
export function chileMonthRange(month: string): { from: Date; to: Date } {
  const match = MONTH.exec(month);
  const year = Number(match?.[1]);
  const index = Number(match?.[2]);
  if (match === null || index < 1 || index > 12) {
    throw new AppError(
      "MONTH_INVALID",
      `El mes debe ser "AAAA-MM" (por ejemplo "2026-10"): "${month}"`,
    );
  }
  const next = index === 12 ? { year: year + 1, index: 1 } : { year, index: index + 1 };
  return { from: chileDayStart(year, index, 1), to: chileDayStart(next.year, next.index, 1) };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * El primer instante de un día de Chile (`"2026-10-19"`; si las 00:00 no existen por el cambio de
 * horario, la 01:00): el borde de los días del calendario del panel (F9-T18). `RangeError` si no
 * tiene esa forma.
 */
export function chileDateStart(day: string): Date {
  const match = DAY.exec(day);
  if (match === null) throw new RangeError(`El día debe ser "AAAA-MM-DD": "${day}"`);
  return chileDayStart(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** El día de Chile (`"2026-10-19"`) de un instante. */
export const chileDateOf = (date: Date): string => formatChileTime(date).slice(0, 10);

/** El mes de Chile (`"2026-10"`) de un instante. */
export const chileMonthOf = (date: Date): string => formatChileTime(date).slice(0, 7);

// --- Cómo se lee una fecha en el panel --------------------------------------------------------

const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const MONTHS_SHORT = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

/**
 * Un día `AAAA-MM-DD` como se dice en voz alta: `mié 11 nov`. El año solo aparece si no es el de
 * `now` (por defecto, el de hoy en Chile): `mié 11 nov 2027`.
 */
export function formatChileDay(day: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(day);
  if (match === null) return day;
  const [, year = "", month = "", date = ""] = match;
  const weekday =
    WEEKDAYS_SHORT[new Date(Date.UTC(Number(year), Number(month) - 1, Number(date))).getUTCDay()];
  const named = `${weekday} ${Number(date)} ${MONTHS_SHORT[Number(month) - 1]}`;
  return year === chileDateOf(now).slice(0, 4) ? named : `${named} ${year}`;
}

/** Un instante como se dice en voz alta, en hora de Chile: `mié 11 nov · 12:00`. */
export function formatChileDayTime(date: Date, now: Date = new Date()): string {
  const text = formatChileTime(date);
  return `${formatChileDay(text.slice(0, 10), now)} · ${text.slice(11)}`;
}

/** Un rango de días `AAAA-MM-DD`: `lun 16 nov al dom 22 nov`. */
export const formatChileDayRange = (from: string, to: string, now: Date = new Date()): string =>
  `${formatChileDay(from, now)} al ${formatChileDay(to, now)}`;

/** Una semana de lunes a domingo, por su lunes (`AAAA-MM-DD`): `Semana del lun 16 nov al dom 22 nov`. */
export function formatChileWeek(monday: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(monday);
  if (match === null) return `Semana del ${monday}`;
  const sunday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 6));
  return `Semana del ${formatChileDayRange(monday, sunday.toISOString().slice(0, 10), now)}`;
}
