import type {
  Broker,
  EditorialCadenceEntry,
  EditorialProfileView,
  PlanHistory,
  PostPlatform,
} from "@agentsales/core";

// Los perfiles de prueba de `pnpm eval:social` (spec F9-T22): marcas **inventadas**, escritas aquí
// (nada de datos de clientes ni de `data/muestras/`). Cubren lo que la evaluación mide: un perfil
// sin hechos (la IA no debe afirmar cifras ni clientes), uno con hechos y dos idiomas (el costo de
// un plan y sus textos en los dos) y uno con historial (temas recientes y descartados, para medir
// las repeticiones). Los enlaces usan `example.com`, reservado para documentación.

/** Un perfil de prueba: la marca, su perfil editorial, lo que se pide al plan y su historial. */
export type SocialEvalProfile = {
  /** El nombre de `--profile`. */
  name: string;
  /** Para qué sirve, en una línea. */
  description: string;
  broker: Pick<Broker, "brandName" | "tone" | "fixedHashtags">;
  profile: EditorialProfileView;
  /** Las redes que se piden al plan. */
  platforms: PostPlatform[];
  /** Los días del período (desde mañana, hora de Chile). */
  days: number;
  /** Cuántas ideas se piden. */
  count: number;
  /** Los temas que el plan no debe repetir (los de los últimos 60 días y los descartados). */
  history: PlanHistory;
};

const cadence = (
  postsPerWeek: number,
  days: EditorialCadenceEntry["days"],
  hours: string[],
): EditorialCadenceEntry => ({ postsPerWeek, days, hours, languageGapHours: 6 });

const SIN_HECHOS: SocialEvalProfile = {
  name: "sin-hechos",
  description: "Sin hechos: el plan y los textos no deben afirmar cifras, clientes ni nombres",
  broker: {
    brandName: "Lumbre Estudio",
    tone: "Cercano, claro y sin tecnicismos",
    fixedHashtags: [],
  },
  profile: {
    brokerId: "eval-sin-hechos",
    languages: ["es"],
    audience: "Personas que quieren ordenar la comunicación de su pequeño negocio",
    pillars: [
      {
        key: "oficio",
        name: "El oficio",
        description: "Cómo pensamos y hacemos el trabajo de diseño",
        weight: 2,
      },
      {
        key: "preguntas",
        name: "Preguntas frecuentes",
        description: "Las dudas de quienes nos escriben",
        weight: 1,
      },
    ],
    facts: [],
    avoid: ["precios", "garantizado"],
    cadence: {
      instagram: cadence(2, ["tue", "thu"], ["10:00"]),
      linkedin: cadence(1, ["wed"], ["09:00"]),
    },
    defaultHashtags: ["#diseño", "#comunicación"],
    updatedAt: null,
  },
  platforms: ["instagram", "linkedin"],
  days: 14,
  count: 6,
  history: { recentTopics: [], discardedTopics: [] },
};

const DOS_IDIOMAS: SocialEvalProfile = {
  name: "dos-idiomas",
  description: "Hechos y dos idiomas (es y en) en cuatro redes: el costo de un plan de 10 ideas",
  broker: {
    brandName: "Brújula Software",
    tone: "Directo, curioso y honesto",
    fixedHashtags: ["#BrujulaSoftware"],
  },
  profile: {
    brokerId: "eval-dos-idiomas",
    languages: ["es", "en"],
    audience: "Equipos pequeños de soporte y tecnología en Chile y Latinoamérica",
    pillars: [
      {
        key: "producto",
        name: "Producto",
        description: "Qué hace el planificador de turnos y cómo se usa",
        weight: 2,
      },
      {
        key: "aprendizajes",
        name: "Lo que aprendemos construyendo",
        description: "Decisiones, errores y aciertos del equipo",
        weight: 1,
      },
      {
        key: "equipo",
        name: "El equipo",
        description: "Cómo trabajamos día a día",
        weight: 1,
      },
    ],
    facts: [
      "Brújula Software nació en 2021 en Valparaíso.",
      "El equipo tiene 6 personas.",
      "El producto es un planificador de turnos para equipos de soporte.",
      "Publicamos una versión nueva cada 2 semanas.",
      "El sitio es https://brujula.example.com",
    ],
    avoid: ["competencia", "gratis para siempre"],
    cadence: {
      instagram: cadence(1, ["sat"], ["11:00"]),
      x: cadence(3, ["mon", "wed", "fri"], ["12:00"]),
      linkedin: cadence(2, ["tue", "thu"], ["09:00"]),
      discord: cadence(1, ["fri"], ["18:00"]),
    },
    defaultHashtags: ["#soporte", "#turnos"],
    updatedAt: null,
  },
  platforms: ["instagram", "x", "linkedin", "discord"],
  days: 14,
  count: 10,
  history: { recentTopics: [], discardedTopics: [] },
};

const CON_HISTORIAL: SocialEvalProfile = {
  name: "con-historial",
  description: "Con temas recientes y descartados: mide las ideas repetidas o parecidas",
  broker: { brandName: "Huerta Común", tone: "Cálido y práctico", fixedHashtags: [] },
  profile: {
    brokerId: "eval-con-historial",
    languages: ["es"],
    audience: "Vecinos que quieren cultivar en casa o en la huerta del barrio",
    pillars: [
      {
        key: "cultivo",
        name: "Cultivo",
        description: "Qué sembrar, cuándo y cómo cuidarlo",
        weight: 2,
      },
      {
        key: "comunidad",
        name: "Comunidad",
        description: "Lo que pasa en la huerta y en sus talleres",
        weight: 1,
      },
    ],
    facts: ["Huerta Común hace talleres los sábados.", "Cada taller es para 12 personas."],
    avoid: ["pesticidas"],
    cadence: {
      instagram: cadence(3, ["mon", "wed", "fri"], ["19:00"]),
      discord: cadence(2, ["tue", "sat"], ["10:00"]),
    },
    defaultHashtags: ["#huerta", "#compost"],
    updatedAt: null,
  },
  platforms: ["instagram", "discord"],
  days: 14,
  count: 8,
  history: {
    recentTopics: [
      "Qué sembrar en primavera",
      "Cómo hacer compost en casa",
      "Regar sin desperdiciar agua",
      "El taller de semillas del sábado",
      "Plagas comunes y cómo prevenirlas",
      "Lo que aprendimos esta semana: Cultivo",
      "Detrás de escena: Comunidad",
    ],
    discardedTopics: ["Recetas con lo que cosechamos", "Herramientas básicas para empezar"],
  },
};

/** Los perfiles de prueba, en el orden en que se evalúan. */
export const SOCIAL_EVAL_PROFILES: readonly SocialEvalProfile[] = [
  SIN_HECHOS,
  DOS_IDIOMAS,
  CON_HISTORIAL,
];

/** El perfil con dos idiomas: el de la medición del costo (`docs/integraciones/anthropic-api.md`). */
export const TWO_LANGUAGE_PROFILE = DOS_IDIOMAS.name;
