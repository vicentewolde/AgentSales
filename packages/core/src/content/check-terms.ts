// Listas de la revisión editorial (spec F2 §4.6, `checkContent`). Se compara sobre el texto plegado
// con `foldText` (minúsculas, sin tildes y con un solo espacio): los patrones van sin tildes
// (`ninos`), y las listas de términos se escriben con tildes y se pliegan al usarlas (el mensaje
// muestra la forma con tildes). Los términos no llevan metacaracteres de expresiones regulares.
// Ampliar las listas no cambia `CONTENT_PROMPT_VERSION`: la revisión se calcula al leer y no
// cambia los textos guardados (seguimiento de ADR-0013).

/** Hasta dos palabras entre el prefijo y el grupo: `solo profesionales jóvenes solteros`. */
const FILLER = String.raw`(?:[a-z]+\s+){0,2}`;
/** Prefijos que restringen o prefieren a un grupo: `solo chilenos`, `preferentemente mujeres`. */
const ONLY = String.raw`(?:solo|solamente|unicamente|exclusivamente|preferentemente|se\s+prefieren?|abstenerse|se\s+requiere\s+ser)\s+(?:para\s+|a\s+)?(?:gente\s+|personas\s+)?${FILLER}`;
/** Negaciones: `sin niños`, `no se permiten niños`, `no apto para niños`, `ni niños`. */
const NOT = String.raw`(?:no|sin|ni)\s+(?:se\s+)?(?:aceptan?\s+|aceptamos\s+|admiten?\s+|permiten?\s+|arrienda\s+|apto\s+)?(?:a\s+|para\s+)?(?:inquilinos\s+|arrendatarios\s+)?`;
/**
 * Lo que va antes de una edad y no habla de personas: `antigüedad entre 5 y 10 años`, `juegos
 * para menores de 10 años`. Mira hasta 3 palabras atrás.
 */
const NOT_ABOUT_PEOPLE = String.raw`(?<!\b(?:antiguedad|construccion|construido|construida|edificio|propiedad|juegos|juego|sala|piscina|plaza|area|uso|vida\s+util)\b(?:\s+[a-z0-9]+){0,3}\s)`;

/**
 * Requisitos discriminatorios por nacionalidad, hijos, estado civil, religión, edad o sexo
 * (`docs/04-formato-publicaciones.md`, regla 4). Solo frases que restringen: "ideal para familias
 * con niños" no es un requisito.
 */
export const DISCRIMINATORY_PATTERNS: readonly { reason: string; pattern: RegExp }[] = [
  {
    reason: "nacionalidad",
    pattern: new RegExp(
      String.raw`\b(?:${ONLY}(?:chilen[oa]s?|nacionales|extranjer[oa]s)|${NOT}extranjer[oa]s|nacionalidad\s+chilena)\b`,
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
      String.raw`${NOT_ABOUT_PEOPLE}\b(?:(?:menores|mayores)\s+de\s+\d+\s+anos|entre\s+\d+\s+y\s+\d+\s+anos|edad\s+(?:maxima|minima)|${ONLY}(?:jovenes|adultos\s+jovenes))\b`,
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
  "increíble",
  "único",
  "única",
  "espectacular",
  "impresionante",
  "maravilloso",
  "maravillosa",
  "imperdible",
  "insuperable",
  "inmejorable",
  "fantástico",
  "fantástica",
  "de ensueño",
  "soñado",
  "soñada",
  "el mejor",
  "la mejor",
  "perfecto",
  "perfecta",
];

/**
 * Amenities, espacios y servicios cercanos que un modelo suele inventar (regla 1). Se avisa si el
 * texto menciona uno que no aparece en los datos del brief. Los plurales simples (`s`, `es`) se
 * reconocen solos, salvo en `AMENITY_EXACT`.
 */
export const AMENITY_TERMS: readonly string[] = [
  "piscina",
  "quincho",
  "gimnasio",
  "sauna",
  "jacuzzi",
  "spa",
  "conserjería",
  "conserje",
  "ascensor",
  "terraza",
  "balcón",
  "jardín",
  "logia",
  "sala de eventos",
  "salón de eventos",
  "sala multiuso",
  "lavandería",
  "áreas verdes",
  "juegos infantiles",
  "cowork",
  "bicicletero",
  "estacionamiento de visitas",
  "vista al mar",
  "vista a la cordillera",
  "metro",
  "colegio",
  "jardín infantil",
  "supermercado",
  "mall",
  "centro comercial",
  "universidad",
  "clínica",
  "hospital",
  "parque",
  "playa",
  "ciclovía",
];

/** Términos sin plural automático: `metros` (cuadrados) no es el metro. */
export const AMENITY_EXACT: ReadonlySet<string> = new Set(["metro"]);

/**
 * Números escritos con palabras junto a una distancia o un tiempo (`a cinco minutos`, `dos
 * cuadras`): el modo típico de inventar una cercanía. El valor se busca en los datos como un número.
 */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  quince: 15,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  cien: 100,
};
export const DISTANCE_UNITS = "(?:minutos?|cuadras?|metros|kilometros?|km|horas?)";

/**
 * Datos de contacto que Portal Inmobiliario modera en el título o la descripción (nota de Mercado
 * Libre §9, spec F4 §4.7): el contacto va solo en el aviso (`seller_contact`). Se buscan en el texto
 * sin plegar.
 * - Teléfono: 9 dígitos chilenos (el primero de 2 a 9), con `+56` opcional y separados como mucho
 *   por un espacio, un guion o un paréntesis. Un punto no separa: así `$120.000.000` o `UF 5.800`
 *   no son teléfonos, ni los años o superficies sueltos.
 * - Correo: `algo@dominio.tld`.
 * - Dirección web: con `http`, `www.` o un dominio de los comunes (`.cl`, `.com`…).
 */
export const CONTACT_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  {
    kind: "un teléfono",
    pattern: /(?<![\d.,+])(?:\+\s?56[\s-]?)?\(?[2-9]\)?(?:[\s-]?\d){8}(?!\d|[.,]\d)/,
  },
  { kind: "un correo", pattern: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i },
  {
    kind: "una dirección web",
    pattern:
      /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cl|com|net|org|info|io|app|co|me|site|online|store|es)\b(?:\/\S*)?/i,
  },
];
