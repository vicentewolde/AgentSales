// Listas de la revisión editorial (spec F2 §4.6, `checkContent`). Todo se compara sobre el texto
// plegado con `foldText` (minúsculas, sin tildes y con un solo espacio), así que los términos van
// así: `ninos`, no `niños`. Ampliarlas no cambia `CONTENT_PROMPT_VERSION`: no cambian los textos.

/** Prefijos que restringen a un grupo: `solo chilenos`, `únicamente para mujeres`. */
const ONLY = String.raw`(?:solo|solamente|unicamente|exclusivamente)\s+(?:para\s+|a\s+)?`;
/** Negaciones: `sin niños`, `no se aceptan extranjeros`. */
const NOT = String.raw`(?:no|sin)\s+(?:se\s+)?(?:aceptan?\s+|admiten?\s+|arrienda\s+a\s+)?`;

/**
 * Requisitos discriminatorios por nacionalidad, hijos, estado civil, religión, edad o sexo
 * (`docs/04-formato-publicaciones.md`, regla 4). Solo frases que restringen: "ideal para familias
 * con niños" no es un requisito.
 */
export const DISCRIMINATORY_PATTERNS: readonly { reason: string; pattern: RegExp }[] = [
  {
    reason: "nacionalidad",
    pattern: new RegExp(
      String.raw`\b(?:${ONLY}(?:chilen[oa]s|nacionales|extranjer[oa]s)|${NOT}extranjer[oa]s|nacionalidad\s+chilena)\b`,
    ),
  },
  {
    reason: "hijos",
    pattern: new RegExp(String.raw`\b${NOT}(?:ninos|ninas|hijos|hijas|guaguas|bebes|menores)\b`),
  },
  {
    reason: "estado civil",
    pattern: new RegExp(
      String.raw`\b${ONLY}(?:casad[oa]s|solter[oa]s|matrimonios?|parejas\s+casadas)\b`,
    ),
  },
  {
    reason: "religión",
    pattern: new RegExp(
      String.raw`\b(?:${ONLY}(?:catolic[oa]s|cristian[oa]s|evangelic[oa]s|creyentes|judi[oa]s|musulman[ae]s)|religion\s+(?:catolica|cristiana|evangelica))\b`,
    ),
  },
  {
    reason: "edad",
    pattern: new RegExp(
      String.raw`\b(?:(?:menores|mayores)\s+de\s+\d+\s+anos|entre\s+\d+\s+y\s+\d+\s+anos|edad\s+(?:maxima|minima)|${ONLY}(?:jovenes|adultos\s+jovenes))\b`,
    ),
  },
  {
    reason: "sexo",
    pattern: new RegExp(
      String.raw`\b${ONLY}(?:mujeres|hombres|varones|damas|senoritas|caballeros)\b`,
    ),
  },
];

/** Superlativos vacíos (regla 5): advertencia, porque a veces calzan con un dato. */
export const SUPERLATIVE_TERMS: readonly string[] = [
  "increible",
  "increibles",
  "unico",
  "unica",
  "unicos",
  "unicas",
  "espectacular",
  "espectaculares",
  "impresionante",
  "impresionantes",
  "maravilloso",
  "maravillosa",
  "imperdible",
  "insuperable",
  "inmejorable",
  "fantastico",
  "fantastica",
  "de ensueno",
  "sonado",
  "sonada",
  "el mejor",
  "la mejor",
  "perfecto",
  "perfecta",
];

/**
 * Amenities, espacios y servicios cercanos que un modelo suele inventar (regla 1). Se avisa si el
 * texto menciona uno que no aparece en los datos del brief. Los plurales simples (`s`, `es`) se
 * reconocen solos.
 */
export const AMENITY_TERMS: readonly string[] = [
  "piscina",
  "quincho",
  "gimnasio",
  "sauna",
  "jacuzzi",
  "spa",
  "conserjeria",
  "conserje",
  "ascensor",
  "terraza",
  "balcon",
  "jardin",
  "logia",
  "sala de eventos",
  "salon de eventos",
  "sala multiuso",
  "lavanderia",
  "areas verdes",
  "juegos infantiles",
  "cowork",
  "bicicletero",
  "estacionamiento de visitas",
  "vista al mar",
  "vista a la cordillera",
  "metro",
  "colegio",
  "jardin infantil",
  "supermercado",
  "mall",
  "centro comercial",
  "universidad",
  "clinica",
  "hospital",
  "parque",
  "playa",
  "ciclovia",
];
