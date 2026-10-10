import type { Platform } from "../enums.js";
import { AppError } from "../errors.js";

/**
 * Plataformas donde el clic final lo hace el operador (ADR-0017): el intento deja el formulario
 * listo (`awaiting_manual_confirm`) y la publicación se confirma después, con el enlace o con
 * "No lo publiqué".
 */
export const MANUAL_CONFIRM_PLATFORMS: ReadonlySet<Platform> = new Set(["fb_marketplace"]);

/** Si en la plataforma el clic final es del operador. */
export const requiresManualConfirm = (platform: Platform): boolean =>
  MANUAL_CONFIRM_PLATFORMS.has(platform);

/** El día de Marketplace (límite diario, valor de la UF) es el de Chile (spec F5 §4.7). */
export const MARKETPLACE_TIME_ZONE = "America/Santiago";

/** Avisos por día y cuenta, si la configuración no dice otra cosa (spec F5, D8). */
export const DEFAULT_MARKETPLACE_DAILY_LIMIT = 3;

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** La fecha y hora de `date` en una zona horaria, con `Intl` (sin dependencias). */
function partsIn(timeZone: string, date: Date): DateParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(formatted.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** Cuánto adelanta la hora local a UTC en ese instante (en Chile, -3 o -4 horas). */
function offsetMs(timeZone: string, date: Date): number {
  const p = partsIn(timeZone, date);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return local - Math.floor(date.getTime() / 1000) * 1000;
}

/** El día (`AAAA-MM-DD`) de un instante en una zona horaria. */
export function dateIn(timeZone: string, now: Date): string {
  const { year, month, day } = partsIn(timeZone, now);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Cuándo empezó el día de `now` en una zona horaria, como instante: el límite diario de
 * Marketplace cuenta desde ahí (spec F5 §4.7). Si la medianoche no existe (en Chile el horario de
 * verano empieza a las 00:00), da el primer instante del día.
 */
export function startOfDayIn(timeZone: string, now: Date): Date {
  const { year, month, day } = partsIn(timeZone, now);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  let guess = midnightAsUtc;
  for (let round = 0; round < 3; round += 1) {
    guess = midnightAsUtc - offsetMs(timeZone, new Date(guess));
  }
  // Si la medianoche no existe, el cálculo puede caer en el día anterior: entonces la primera hora.
  if (dateIn(timeZone, new Date(guess)) !== dateIn(timeZone, now)) guess += 60 * 60 * 1000;
  return new Date(guess);
}

/** Otra publicación de la cuenta tiene el formulario abierto (spec F5 §4.7). */
export const marketplaceFormOpen = (publicationId: string) =>
  new AppError(
    "MARKETPLACE_FORM_OPEN",
    "Ya hay un formulario de Marketplace abierto en esta cuenta: publícalo o márcalo como no publicado antes de abrir otro",
    { details: { publicationId } },
  );

/** La cuenta llegó a su límite diario (spec F5 §4.7, D8). */
export const marketplaceDailyLimitReached = (limit: number) =>
  new AppError(
    "MARKETPLACE_DAILY_LIMIT",
    `Esta cuenta ya llegó a ${limit} ${limit === 1 ? "aviso" : "avisos"} de Marketplace hoy: sigue mañana`,
    { details: { limit } },
  );

/**
 * Una publicación espera el clic del operador: primero tiene que decir si la publicó o no (spec F5
 * §4.3, D11). Lo dicen descartar, quitar la aprobación, desconectar y volver a publicar.
 */
export const manualConfirmPending = (publicationId: string) =>
  new AppError(
    "MANUAL_CONFIRM_PENDING",
    "Una publicación espera tu clic final en Marketplace: di si la publicaste (pega el enlace) o márcala como no publicada",
    { details: { publicationId } },
  );

/**
 * Ya hay una acción del perfil de Facebook esperando su turno (spec F5 §4.2): la cola
 * `marketplace.profile` es `stately` por corredor (una activa y una en cola). Lo dicen iniciar
 * sesión y desconectar, sin cambiar nada.
 */
export const marketplaceProfileActionPending = (brokerId: string) =>
  new AppError(
    "MARKETPLACE_PROFILE_ACTION_PENDING",
    "Ya hay una acción del perfil de Facebook esperando (un inicio de sesión o un borrado): reintenta en un momento",
    { details: { brokerId } },
  );
