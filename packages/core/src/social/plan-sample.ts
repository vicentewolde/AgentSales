import { z } from "zod";
import { POST_PLATFORMS, type PostKind, type PostPlatform } from "../enums.js";
import type { PlanIdea } from "./plan.js";
import { topicKey } from "./plan.js";
import { PLAN_DATA_TAG } from "./plan-prompt.js";

// El plan de ejemplo del proveedor `fake` (`LLM_PROVIDER=fake`, F9-T20): ideas deterministas que
// pasan las verificaciones de `checkPlanIdeas` con cualquier perfil, para probar el flujo (T21) y
// la evaluación (T22) sin gastar cuota. Lee lo pedido del bloque de datos del prompt, que arma core
// (`buildPlanPrompt`): sin red ni azar.

/** Lo que el ejemplo lee del bloque de datos (lo demás lo ignora). */
const sampleDataSchema = z.object({
  marca: z.string().optional(),
  lineas: z
    .array(z.object({ clave: z.string(), nombre: z.string(), peso: z.number() }))
    .default([]),
  dias_del_periodo: z.array(z.object({ fecha: z.string(), dia: z.string() })).default([]),
  redes_pedidas: z.array(z.enum(POST_PLATFORMS)).default([]),
  cadencia: z
    .record(
      z.string(),
      z.object({
        posts_por_semana: z.number(),
        dias: z.array(z.string()).default([]),
        horas: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  ideas_pedidas: z.number().int().nonnegative().default(0),
  temas_recientes: z.array(z.string()).default([]),
  ideas_descartadas: z.array(z.string()).default([]),
});

/** Ángulos de un tema: frases sin cifras ni nombres propios (pasan `unsupportedFacts`). */
const ANGLES = [
  "Lo que aprendimos esta semana",
  "Cómo trabajamos por dentro",
  "Una pregunta para quienes nos siguen",
  "Un error que nos enseñó algo",
  "Lo que viene",
  "Detrás de escena",
  "Una herramienta que usamos a diario",
  "Un consejo práctico",
  "Una decisión difícil",
  "Lo que más nos preguntan",
  "Un mito común",
  "Cómo empezamos",
];

/** Las vueltas que se agregan cuando un ángulo ya se usó (un plan tras otro no se repite). */
const VARIANTS = ["", " (otra mirada)", " (en corto)", " (paso a paso)", " (lo esencial)"];

/** El formato que sirve en la red (Instagram necesita imagen; TikTok, video). */
const kindFor = (platform: PostPlatform): PostKind =>
  platform === "tiktok" ? "video" : platform === "instagram" ? "image" : "text";

/** El lunes de la semana de un día (`AAAA-MM-DD`). */
function mondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** Los datos del bloque del prompt, o `null` si no están o no se leen. */
function readData(prompt: string): z.infer<typeof sampleDataSchema> | null {
  const start = prompt.indexOf(`<${PLAN_DATA_TAG}>`);
  const end = prompt.indexOf(`</${PLAN_DATA_TAG}>`);
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = sampleDataSchema.safeParse(
      JSON.parse(prompt.slice(start + PLAN_DATA_TAG.length + 2, end)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * La respuesta de ejemplo para un prompt del plan: `ideas_pedidas` ideas de una red cada una, en
 * los días y horas de la cadencia de cada red (las 10:00 si no tiene), sin pasar sus posts por
 * semana, repartidas a lo largo del período; las líneas por turno (entre las de peso mayor que 0);
 * y temas que no repiten los recientes ni los descartados. Si el período no da para tantas, menos
 * ideas (y una advertencia). Determinista: el mismo prompt da la misma respuesta.
 */
export function samplePlanResponse(prompt: string): { ideas: PlanIdea[]; warnings: string[] } {
  const data = readData(prompt);
  if (data === null) {
    return { ideas: [], warnings: ["El ejemplo no encontró los datos del plan en el prompt"] };
  }
  // Los huecos posibles: cada día y cada red, en su cadencia y sin pasar su tope semanal.
  const slots: { date: string; hour: string; platform: PostPlatform }[] = [];
  const perWeek = new Map<string, number>();
  for (const { fecha, dia } of data.dias_del_periodo) {
    for (const platform of data.redes_pedidas) {
      const cadence = data.cadencia[platform];
      if (cadence !== undefined) {
        if (cadence.dias.length > 0 && !cadence.dias.includes(dia)) continue;
        const key = `${platform}:${mondayOf(fecha)}`;
        if ((perWeek.get(key) ?? 0) >= cadence.posts_por_semana) continue;
        perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
      }
      slots.push({ date: fecha, hour: cadence?.horas[0] ?? "10:00", platform });
    }
  }
  const count = Math.min(data.ideas_pedidas, slots.length);
  // Repartidas en el período: los huecos a intervalos parejos.
  const chosen = Array.from(
    { length: count },
    (_, index) => slots[Math.floor((index * slots.length) / count)],
  ).filter((slot) => slot !== undefined);

  const used = new Set([...data.temas_recientes, ...data.ideas_descartadas].map(topicKey));
  const pillars = data.lineas.filter((pillar) => pillar.peso > 0);
  /** El primer tema libre para una línea (o para la marca, sin líneas), que queda usado. */
  const nextTopic = (pillar: { nombre: string } | null): string | null => {
    for (const variant of VARIANTS) {
      for (const angle of ANGLES) {
        const topic = `${angle}${pillar === null ? "" : `: ${pillar.nombre}`}${variant}`;
        if (used.has(topicKey(topic))) continue;
        used.add(topicKey(topic));
        return topic;
      }
    }
    return null;
  };

  const ideas: PlanIdea[] = [];
  chosen.forEach((slot, index) => {
    const pillar = pillars.length === 0 ? null : (pillars[index % pillars.length] ?? null);
    const topic = nextTopic(pillar);
    if (topic === null) return;
    ideas.push({
      tema: topic,
      linea: pillar?.clave ?? null,
      redes: [slot.platform],
      formato: kindFor(slot.platform),
      fecha: slot.date,
      hora: slot.hour,
      porque: "Mantiene la cadencia de la red y reparte las líneas del perfil.",
    });
  });
  const warnings =
    ideas.length < data.ideas_pedidas
      ? ["El período y la cadencia no dan para todas las ideas pedidas"]
      : [];
  return { ideas, warnings };
}
