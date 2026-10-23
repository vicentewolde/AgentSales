import { z } from "zod";
import { POST_PLATFORMS, type PostKind, type PostPlatform } from "../enums.js";
import { kindProblem } from "./networks.js";
import type { PlanIdea } from "./plan.js";
import { topicKey } from "./plan.js";
import { PLAN_DATA_TAG } from "./plan-prompt.js";

// El plan de ejemplo del proveedor `fake` (`LLM_PROVIDER=fake`, F9-T20): ideas deterministas que
// pasan las verificaciones de `checkPlanIdeas` con cualquier perfil, para probar el flujo (T21) y
// la evaluación (T22) sin gastar cuota. Lee lo pedido del bloque de datos del prompt, que arma core
// (`buildPlanPrompt`): sin red ni azar. Desde F9.5 (ADR-0034) no manda fecha ni hora: las ranuras
// las pone el código, y si la cadencia no da para todas, las de sobra quedan como `NO_SLOT`.

/** Lo que el ejemplo lee del bloque de datos (lo demás lo ignora). */
const sampleDataSchema = z.object({
  lineas: z
    .array(z.object({ clave: z.string(), nombre: z.string(), peso: z.number() }))
    .default([]),
  redes_pedidas: z.array(z.enum(POST_PLATFORMS)).default([]),
  ideas_pedidas: z.number().int().nonnegative().default(0),
  temas_recientes: z.array(z.string()).default([]),
  ideas_descartadas: z.array(z.string()).default([]),
  pedido_del_operador: z.string().optional(),
});

/**
 * Ángulos de un tema: frases sin cifras ni nombres propios (pasan `unsupportedFacts`), sin palabras
 * con peso en común (no se parecen entre sí, `topicSimilarity`) y sin primera persona del plural
 * (pasan `FIRST_PERSON_PLURAL` con cualquier perfil, F9.5-T23). Son tantos como el tope de ideas de
 * un plan (`PLAN_MAX_IDEAS`): dentro de un plan, ninguno se repite.
 */
const ANGLES = [
  "Lo que se aprendió esta semana",
  "Cómo se trabaja por dentro",
  "Una pregunta para la comunidad",
  "Un error que enseñó algo",
  "Lo que viene",
  "Detrás de escena",
  "Una herramienta de uso diario",
  "Un consejo práctico",
  "Una decisión difícil",
  "Las dudas más frecuentes",
  "Un mito común",
  "Cómo empezó todo",
  "Lo que se haría distinto",
  "Un proceso simplificado",
  "Lo que inspira",
  "Una costumbre de la casa",
  "Una idea que quedó atrás",
  "Un día cualquiera",
  "Una recomendación sincera",
  "Lo que todavía no se sabe",
];

/**
 * El tema de la idea que refleja el pedido del operador (F9.5-T23): el pedido tal cual, recortado
 * en una palabra. Si trae cifras o nombres que no están en el perfil, la verificación lo descarta
 * (`FACT_NOT_IN_PROFILE`): así se prueba que el pedido no se vuelve un hecho.
 */
const PEDIDO_TOPIC_MAX = 100;
function pedidoTopic(pedido: string): string | null {
  const flat = pedido.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  const space = flat.lastIndexOf(" ", PEDIDO_TOPIC_MAX);
  const cut =
    flat.length <= PEDIDO_TOPIC_MAX ? flat : flat.slice(0, space > 0 ? space : PEDIDO_TOPIC_MAX);
  return `Según tu pedido: ${cut}`;
}

/** Las vueltas que se agregan cuando un ángulo ya se usó (un plan tras otro no se repite). */
const VARIANTS = ["", " (otra mirada)", " (en corto)", " (paso a paso)", " (lo esencial)"];

/** Los formatos que se turnan en cada red (Instagram necesita imagen o video; TikTok, video). */
const KINDS: Readonly<Record<PostPlatform, readonly PostKind[]>> = {
  instagram: ["image", "carousel", "video"],
  tiktok: ["video"],
  x: ["text", "image", "carousel"],
  linkedin: ["text", "image", "carousel"],
  discord: ["text", "image", "carousel"],
};

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
 * La respuesta de ejemplo para un prompt del plan: `ideas_pedidas` ideas, en orden; cada una
 * empieza por una red pedida (por turno), con un formato que esa red admite (por turno) y, como
 * redes preferidas, esa y las demás pedidas que admiten el formato; las líneas por turno (entre las
 * de peso mayor que 0); y temas con un ángulo distinto cada uno que no repiten los recientes ni los
 * descartados. Sin fecha ni hora. Con `pedido_del_operador` (F9.5-T23), la primera idea lo
 * refleja en su tema (`pedidoTopic`) y su porqué lo dice. Determinista: el mismo prompt da la misma
 * respuesta.
 */
export function samplePlanResponse(prompt: string): { ideas: PlanIdea[]; warnings: string[] } {
  const data = readData(prompt);
  if (data === null) {
    return { ideas: [], warnings: ["El ejemplo no encontró los datos del plan en el prompt"] };
  }
  const networks = data.redes_pedidas;
  if (networks.length === 0) return { ideas: [], warnings: ["No se pidió ninguna red"] };

  const used = new Set([...data.temas_recientes, ...data.ideas_descartadas].map(topicKey));
  const pillars = data.lineas.filter((pillar) => pillar.peso > 0);
  let cursor = 0;
  /** El primer tema libre con el ángulo siguiente (para una línea, o para la marca sin líneas). */
  const nextTopic = (pillar: { nombre: string } | null): string | null => {
    for (const variant of VARIANTS) {
      for (let offset = 0; offset < ANGLES.length; offset += 1) {
        const index = (cursor + offset) % ANGLES.length;
        const topic = `${ANGLES[index]}${pillar === null ? "" : `: ${pillar.nombre}`}${variant}`;
        if (used.has(topicKey(topic))) continue;
        used.add(topicKey(topic));
        cursor = index + 1;
        return topic;
      }
    }
    return null;
  };

  const ideas: PlanIdea[] = [];
  for (let index = 0; index < data.ideas_pedidas; index += 1) {
    const platform = networks[index % networks.length] as PostPlatform;
    const kinds = KINDS[platform];
    const kind = kinds[Math.floor(index / networks.length) % kinds.length] as PostKind;
    const pillar = pillars.length === 0 ? null : (pillars[index % pillars.length] ?? null);
    const pedido = index === 0 ? pedidoTopic(data.pedido_del_operador ?? "") : null;
    const topic = pedido ?? nextTopic(pillar);
    if (topic === null) break;
    ideas.push({
      tema: topic,
      linea: pillar?.clave ?? null,
      redes: [
        platform,
        ...networks.filter((other) => other !== platform && kindProblem(other, kind) === null),
      ],
      formato: kind,
      porque:
        pedido === null
          ? "Suma un ángulo y un formato distintos al plan, y reparte las líneas del perfil."
          : "Responde a lo que pidió el operador para este plan.",
    });
  }
  return { ideas, warnings: [] };
}
