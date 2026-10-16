import { CliError } from "./output.js";

// La hora de Chile en la CLI (spec F6 §4.3): el operador escribe "2026-10-19 10:00" y la API
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
 * `"2026-10-19 10:00"` en hora de Chile → el instante. `SCHEDULE_AT_INVALID` (de la CLI) si no
 * tiene esa forma o si la hora no existe en Chile por el cambio de horario.
 */
export function parseChileTime(text: string): Date {
  const match = INPUT.exec(text.trim());
  if (match === null) {
    throw new CliError(
      "SCHEDULE_AT_INVALID",
      `--at debe ser "AAAA-MM-DD HH:MM" en hora de Chile (por ejemplo "2026-10-19 10:00"): "${text}"`,
    );
  }
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const wall = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  // Los dos desplazamientos posibles (invierno y verano): la primera vez que esa hora existe.
  const candidates = [...new Set([-240, -180].map((offset) => wall - offset * 60_000))]
    .map((ms) => new Date(ms))
    .filter((date) => offsetMinutes(date) * 60_000 === wall - date.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  const found = candidates[0];
  if (found === undefined || formatChileTime(found) !== formatParts(match)) {
    throw new CliError(
      "SCHEDULE_AT_INVALID",
      `Las ${text.trim()} no existen en Chile: ese día se adelanta el reloj (elige otra hora)`,
    );
  }
  return found;
}

const formatParts = (match: RegExpExecArray) =>
  `${match[1]}-${match[2]}-${match[3]} ${String(match[4]).padStart(2, "0")}:${match[5]}`;
