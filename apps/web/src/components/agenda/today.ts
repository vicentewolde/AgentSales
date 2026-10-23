import { CHILE_TIME_ZONE } from "@agentsales/core";

// La bienvenida de «Hoy» (F9.5-T26): el saludo por la hora de Chile, la fecha y la frase del día.
// Funciones puras para probarlas sin la página.

const HOUR = new Intl.DateTimeFormat("es-CL", {
  timeZone: CHILE_TIME_ZONE,
  hour: "numeric",
  hourCycle: "h23",
});

const TODAY = new Intl.DateTimeFormat("es-CL", {
  timeZone: CHILE_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** «Buenos días» (5:00 a 11:59), «Buenas tardes» (12:00 a 19:59) o «Buenas noches», en Chile. */
export function greeting(now: Date): string {
  const hour = Number(HOUR.format(now));
  if (hour >= 5 && hour < 12) return "Buenos días";
  if (hour >= 12 && hour < 20) return "Buenas tardes";
  return "Buenas noches";
}

/** El saludo con el primer nombre del usuario, o solo el saludo si no hay nombre. */
export function greetingLine(now: Date, name: string | undefined): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return first === "" ? greeting(now) : `${greeting(now)}, ${first}`;
}

/** La fecha de hoy en Chile, con mayúscula: «Jueves, 22 de octubre». */
export function todayText(now: Date): string {
  const text = TODAY.format(now);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** La frase del día: lo que te espera y lo que sale en la semana (`null` mientras carga). */
export function daySummary(todo: number | undefined, upcoming: number | undefined): string | null {
  if (todo === undefined || upcoming === undefined) return null;
  const first =
    todo === 0
      ? "Hoy no tienes nada pendiente."
      : todo === 1
        ? "Hoy 1 cosa te espera."
        : `Hoy ${todo} cosas te esperan.`;
  const second =
    upcoming === 0
      ? "En los próximos 7 días no hay nada programado."
      : upcoming === 1
        ? "En los próximos 7 días sale 1 publicación."
        : `En los próximos 7 días salen ${upcoming} publicaciones.`;
  return `${first} ${second}`;
}
