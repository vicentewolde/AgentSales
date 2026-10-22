import { parseChileTime } from "../chile-time.js";
import { EDITORIAL_WEEKDAYS, type EditorialWeekday } from "../editorial-profile.js";
import type { PostPlatform } from "../enums.js";
import { isAppError } from "../errors.js";

// Las ranuras del plan de ideas (spec F9.5, D7; ADR-0034): el código, no la IA, pone la fecha, la
// hora y las redes de cada idea según la cadencia de cada red. Funciones puras, sin la base: las usa
// `checkPlanIdeas` (`plan.ts`). Las fechas son días de Chile (`"2026-10-21"`) y las horas, de Chile
// (`"10:00"`).

/** El día de Chile `n` días después (o antes, con `n` negativo). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** El día de la semana de un día de Chile (`mon` … `sun`). */
export function weekdayOf(day: string): EditorialWeekday {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  // `getUTCDay`: 0 es domingo; `EDITORIAL_WEEKDAYS` empieza el lunes.
  const index = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return EDITORIAL_WEEKDAYS[index] as EditorialWeekday;
}

/** El lunes de la semana (de lunes a domingo, como en Chile) de un día. */
export const weekOf = (day: string) => addDays(day, -EDITORIAL_WEEKDAYS.indexOf(weekdayOf(day)));

/**
 * La ranura por defecto de una red sin cadencia, o con días u horas vacíos (D7): los días hábiles,
 * a las 10:00 de Chile, con un post por semana (sin cadencia).
 */
export const PLAN_DEFAULT_SLOT = {
  days: ["mon", "tue", "wed", "thu", "fri"] as readonly EditorialWeekday[],
  hours: ["10:00"] as readonly string[],
  postsPerWeek: 1,
} as const;

/** La cadencia de una red tal como la usa el plan (las horas de espacio entre idiomas no aplican). */
export type PlanCadence = { postsPerWeek: number; days: EditorialWeekday[]; hours: string[] };

/** Las reglas de ranura de una red: sus días, horas, posts por semana y como mucho cuántos por día. */
export type PlanSlotRules = {
  postsPerWeek: number;
  days: EditorialWeekday[];
  hours: string[];
  /**
   * El espacio mínimo: como mucho estos posts de la red en un mismo día, los justos para llegar a
   * sus posts por semana en sus días (`ceil(posts por semana / días)`; uno, si le alcanzan los días).
   */
  perDay: number;
};

/**
 * Las reglas de ranura de una red (D7): las de su cadencia; sin cadencia, `PLAN_DEFAULT_SLOT`; con
 * días u horas vacíos, los de `PLAN_DEFAULT_SLOT` en lo que falta (sus posts por semana se quedan).
 */
export function planSlotRules(cadence: PlanCadence | undefined): PlanSlotRules {
  const days =
    cadence === undefined || cadence.days.length === 0
      ? [...PLAN_DEFAULT_SLOT.days]
      : EDITORIAL_WEEKDAYS.filter((day) => cadence.days.includes(day));
  const hours =
    cadence === undefined || cadence.hours.length === 0
      ? [...PLAN_DEFAULT_SLOT.hours]
      : [...new Set(cadence.hours)].sort();
  const postsPerWeek = cadence?.postsPerWeek ?? PLAN_DEFAULT_SLOT.postsPerWeek;
  return {
    postsPerWeek,
    days,
    hours,
    perDay: Math.max(1, Math.ceil(postsPerWeek / days.length)),
  };
}

/** Una ranura: un día y una hora de Chile, y su instante. */
export type PlanSlot = { date: string; time: string; at: Date };

/**
 * Las ranuras de una red en el período: cada día de `days` que cae en sus días, a cada una de sus
 * horas, dentro de `[start, end)` y desde `now`, en orden. Una hora que no existe en Chile (el día
 * que se adelanta el reloj) no es ranura. Con 0 posts por semana, ninguna.
 */
export function planSlots(
  rules: PlanSlotRules,
  bounds: { days: readonly string[]; start: Date; end: Date; now: Date },
): PlanSlot[] {
  if (rules.postsPerWeek <= 0) return [];
  const slots: PlanSlot[] = [];
  for (const date of bounds.days) {
    if (!rules.days.includes(weekdayOf(date))) continue;
    for (const time of rules.hours) {
      let at: Date;
      try {
        at = parseChileTime(`${date} ${time}`);
      } catch (error) {
        // Solo la hora que no existe en Chile (el día que se adelanta el reloj); lo demás, se relanza.
        if (isAppError(error) && error.code === "SCHEDULE_AT_INVALID") continue;
        throw error;
      }
      if (at < bounds.start || at >= bounds.end || at < bounds.now) continue;
      slots.push({ date, time, at });
    }
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Un post que ya ocupa un día (y, si se sabe, una hora) del período en unas redes. */
export type PlannedSlot = { date: string; time?: string; platforms: PostPlatform[] };

/** La ranura que le tocó a una idea y las redes que la tienen libre. */
export type AssignedPlanSlot = { slot: PlanSlot; platforms: PostPlatform[] };

/**
 * El cuaderno de ranuras de un plan (D7): sabe qué ranuras tiene cada red y cuáles ya están
 * ocupadas, por lo ya planificado (`planned`) y por las ideas que va asignando (`assign`). Una red
 * tiene libre una ranura si es de su cadencia, si esa semana (de lunes a domingo) no llegó a sus
 * posts por semana, si ese día no llegó a su máximo por día y si nada ocupa ya ese día y hora.
 */
export function planSlotBook(params: {
  /** Los días del período, en orden. */
  days: readonly string[];
  cadence: Partial<Record<PostPlatform, PlanCadence>>;
  planned: readonly PlannedSlot[];
  start: Date;
  end: Date;
  now: Date;
}) {
  const rulesOf = new Map<PostPlatform, PlanSlotRules>();
  const slotsOf = new Map<PostPlatform, PlanSlot[]>();
  const perWeek = new Map<string, number>();
  const perDay = new Map<string, number>();
  const taken = new Set<string>();
  /** Cuántas ideas (y posts ya planificados) tiene cada semana: se reparte primero en las vacías. */
  const weekLoad = new Map<string, number>();
  const weeks = [...new Set(params.days.map(weekOf))];
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  const rules = (platform: PostPlatform): PlanSlotRules => {
    let found = rulesOf.get(platform);
    if (found === undefined) {
      found = planSlotRules(params.cadence[platform]);
      rulesOf.set(platform, found);
    }
    return found;
  };
  const slots = (platform: PostPlatform): PlanSlot[] => {
    let found = slotsOf.get(platform);
    if (found === undefined) {
      found = planSlots(rules(platform), params);
      slotsOf.set(platform, found);
    }
    return found;
  };
  const occupy = (platform: PostPlatform, date: string, time: string | undefined) => {
    bump(perWeek, `${platform}|${weekOf(date)}`);
    bump(perDay, `${platform}|${date}`);
    if (time !== undefined) taken.add(`${platform}|${date} ${time}`);
  };
  const isFree = (platform: PostPlatform, slot: PlanSlot): boolean => {
    const own = rules(platform);
    return (
      slots(platform).some((item) => item.at.getTime() === slot.at.getTime()) &&
      (perWeek.get(`${platform}|${weekOf(slot.date)}`) ?? 0) < own.postsPerWeek &&
      (perDay.get(`${platform}|${slot.date}`) ?? 0) < own.perDay &&
      !taken.has(`${platform}|${slot.date} ${slot.time}`)
    );
  };

  for (const item of params.planned) {
    for (const platform of item.platforms) occupy(platform, item.date, item.time);
    bump(weekLoad, weekOf(item.date));
  }

  return {
    rules,
    /**
     * La ranura de una idea entre sus redes candidatas (D7): la más temprana libre en alguna de
     * ellas, buscando primero en las semanas con menos ideas (a igual carga, la más temprana); las
     * redes de la idea son las candidatas que tienen libre esa ranura, y quedan ocupadas. `null` si
     * ninguna candidata tiene una ranura libre en el período.
     */
    assign(candidates: readonly PostPlatform[]): AssignedPlanSlot | null {
      const order = weeks
        .map((week, index) => ({ week, index, load: weekLoad.get(week) ?? 0 }))
        .sort((a, b) => a.load - b.load || a.index - b.index);
      for (const { week } of order) {
        const options = candidates
          .flatMap((platform) => slots(platform))
          .filter((slot) => weekOf(slot.date) === week)
          .sort((a, b) => a.at.getTime() - b.at.getTime());
        for (const slot of options) {
          const platforms = candidates.filter((platform) => isFree(platform, slot));
          if (platforms.length === 0) continue;
          for (const platform of platforms) occupy(platform, slot.date, slot.time);
          bump(weekLoad, week);
          return { slot, platforms };
        }
      }
      return null;
    },
  };
}

export type PlanSlotBook = ReturnType<typeof planSlotBook>;
