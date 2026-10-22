// Muletillas de texto escrito por IA (spec F9.5, D6): frases hechas, clichés de vendedor y marcas
// de estilo que delatan un texto generado. La revisión las marca como advertencia (`AI_TELL`), no
// como error: el operador decide. Se usan en los avisos (`checkContent`) y en los posts
// (`checkPostContent`), en español y en inglés, y las cuentan `eval:content` y `eval:social`.
//
// Las frases se comparan sobre el texto plegado (minúsculas y sin tildes, `foldKeepingLength`) y
// como palabra o frase completa: «sin duda» no calza dentro de otra palabra, y «elevated» no es
// «elevate». Ampliar la lista no cambia las versiones de los prompts: la revisión se calcula al leer.

/** Qué clase de muletilla es: una frase hecha o una marca de estilo. */
export type AiTellKind = "phrase" | "exclamations" | "dash" | "triad" | "emojis";

/** Una muletilla encontrada: `text` es la frase de la lista o el trozo del texto que la delata. */
export type AiTell = { kind: AiTellKind; text: string };

/**
 * Las frases hechas, en español y en inglés: la forma que se muestra (con tildes) y el patrón sobre
 * el texto plegado. En el patrón, un espacio es «uno o más espacios» y ` ?` es «espacios o nada».
 */
const PHRASES: readonly (readonly [label: string, pattern: string])[] = [
  // Español.
  ["descubre", "descubr(?:e|a|an)"],
  ["sumérgete", "sumerg(?:ete|ase|anse)"],
  [
    "no es solo X, es Y",
    "no (?:es|son) (?:solo|solamente|simplemente|unicamente) [^.!?\\n]{1,80}?[,;:.—–] ?(?:es|son|sino)",
  ],
  ["no se trata solo de X", "no se trata (?:solo|solamente|unicamente) de"],
  ["en el corazón de", "en (?:el|pleno) corazon de"],
  ["sin duda", "sin (?:ninguna )?duda|sin lugar a dudas"],
  ["te espera", "te (?:espera|esperan|esta esperando|estan esperando)"],
  ["un oasis", "oasis"],
  ["ideal para quienes buscan", "(?:ideal|perfect[oa]) para quienes"],
  [
    "no te lo pierdas",
    "no te (?:lo|la|los|las) pierdas|no dejes pasar|no pierdas (?:esta|la) oportunidad",
  ],
  ["al siguiente nivel", "al (?:siguiente|proximo) nivel|a otro nivel"],
  [
    "en el mundo actual",
    "en el mundo (?:actual|de hoy)|en la era digital|en un mundo cada vez|hoy mas que nunca",
  ],
  ["vive la experiencia", "vive (?:la|una) experiencia"],
  ["déjate sorprender", "dejate (?:sorprender|enamorar|cautivar|seducir)"],
  ["a la perfección", "a la perfeccion"],
  ["la combinación perfecta", "(?:combinacion|equilibrio|balance|fusion) perfect[oa]"],
  ["de tus sueños", "de (?:tus|sus) suenos"],
  [
    "cabe destacar",
    "cabe (?:destacar|mencionar|senalar)|es importante (?:destacar|mencionar|senalar)|vale la pena (?:destacar|mencionar)",
  ],
  ["¿sabías que…?", "sabias que"],
  ["el secreto mejor guardado", "secreto mejor guardado"],
  ["revoluciona", "revolucion(?:a|an|ar|ando)"],
  ["potencia tu", "potencia(?:r)? (?:tu|tus|su|sus)"],
  ["en resumen", "en resumen"],
  ["un sinfín de", "un sinfin de"],
  ["el hogar que mereces", "que (?:te )?mereces"],
  ["sin precedentes", "sin precedentes"],
  ["a tan solo", "a tan solo"],
  // Inglés.
  ["discover", "discover(?:s)?"],
  ["Experience…", "(?:(?<=^\\s*)|(?<=[.!?…]\\s+))experience"],
  ["nestled", "nestled"],
  ["look no further", "look no further"],
  ["unlock", "unlock(?:s|ing|ed)?"],
  ["elevate", "elevat(?:e|es|ing)"],
  ["seamless", "seamless(?:ly)?"],
  ["game-changer", "game[- ]?chang(?:er|ers|ing)"],
  [
    "in today's fast-paced world",
    "in today'?s (?:(?:fast-paced|ever-changing|digital|competitive|modern) )?(?:world|age|landscape|market)|fast-paced world",
  ],
  [
    "it's not just X, it's Y",
    "(?:(?:it'?s|it is|this is|that'?s|is|are) not|isn'?t|aren'?t) (?:just|only|merely|simply) [^.!?\\n]{1,80}?[,;:.—–] ?(?:it'?s|it is|they'?re|this is|that'?s|but)",
  ],
  ["dive into", "(?:let'?s )?dive (?:in|into|deep)|deep dive"],
  ["delve", "delv(?:e|es|ing)"],
  ["tapestry", "tapestry"],
  ["a testament to", "testament to"],
  ["boasts", "boasts"],
  ["whether you're", "whether you'?re"],
  ["embark on", "embark(?:s|ing)? on"],
  ["in the heart of", "in the (?:very )?heart of"],
  ["a haven", "haven"],
  ["dream home", "dream (?:home|house|property)"],
  ["don't miss", "don'?t miss"],
  ["unparalleled", "unparall?eled"],
  ["next level", "the next level"],
  ["leverage", "leverag(?:e|es|ing)"],
  ["harness the power", "harness(?:ing)? the power"],
  ["ever-evolving", "ever[- ](?:evolving|changing)"],
  ["without a doubt", "without a doubt|undoubtedly"],
  ["picture this", "picture this"],
];

/** El patrón de una frase: espacios flexibles y como palabra completa. */
const phrasePattern = (pattern: string) =>
  new RegExp(
    String.raw`(?<![\p{L}\p{N}'])(?:${pattern.replaceAll(" ?", String.raw`\s*`).replaceAll(" ", String.raw`\s+`)})(?![\p{L}\p{N}])`,
    "mu",
  );

const PHRASE_PATTERNS = PHRASES.map(([label, pattern]) => ({
  label,
  pattern: phrasePattern(pattern),
}));

/** Adjetivos que la IA junta de a tres («amplio, luminoso y moderno»), plegados y en singular. */
const TRIAD_ADJECTIVES_ES = [
  "amplio",
  "luminoso",
  "moderno",
  "acogedor",
  "comodo",
  "funcional",
  "elegante",
  "tranquilo",
  "espacioso",
  "calido",
  "versatil",
  "exclusivo",
  "sofisticado",
  "practico",
  "seguro",
  "privilegiado",
  "perfecto",
  "ideal",
  "encantador",
  "impecable",
  "renovado",
  "contemporaneo",
  "sereno",
  "armonioso",
  "vibrante",
  "autentico",
  "innovador",
  "eficiente",
  "sostenible",
  "accesible",
  "confiable",
  "agil",
  "simple",
  "sencillo",
  "intuitivo",
  "rapido",
  "flexible",
  "potente",
  "robusto",
  "escalable",
  "unico",
  "fresco",
  "dinamico",
];

const TRIAD_ADJECTIVES_EN = [
  "spacious",
  "bright",
  "modern",
  "cozy",
  "cosy",
  "elegant",
  "stylish",
  "sleek",
  "functional",
  "comfortable",
  "charming",
  "stunning",
  "vibrant",
  "innovative",
  "efficient",
  "seamless",
  "intuitive",
  "powerful",
  "robust",
  "scalable",
  "reliable",
  "simple",
  "fast",
  "secure",
  "flexible",
  "sustainable",
  "authentic",
  "timeless",
  "sophisticated",
  "luxurious",
  "inviting",
  "welcoming",
  "serene",
  "peaceful",
  "airy",
  "versatile",
  "practical",
  "smart",
  "unique",
  "beautiful",
  "warm",
  "fresh",
  "dynamic",
];

/** Las formas de un adjetivo en español: género y número (`amplio` → `amplia`, `amplios`…). */
function spanishForms(word: string): string[] {
  if (word.endsWith("o"))
    return [word, `${word.slice(0, -1)}a`, `${word}s`, `${word.slice(0, -1)}as`];
  if (word.endsWith("or")) return [word, `${word}a`, `${word}es`, `${word}as`];
  if (word.endsWith("e")) return [word, `${word}s`];
  return [word, `${word}es`];
}

const ADJECTIVE = `(?:${[
  ...new Set([...TRIAD_ADJECTIVES_ES.flatMap(spanishForms), ...TRIAD_ADJECTIVES_EN]),
].join("|")})`;

/** Tres adjetivos de la lista seguidos: «amplio, luminoso y moderno», «simple, fast, and reliable». */
const TRIAD = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${ADJECTIVE},\s+${ADJECTIVE},?\s+(?:y|e|and|&)\s+${ADJECTIVE}(?![\p{L}\p{N}])`,
  "gu",
);

/** Un guion largo como pausa entre palabras («la vista — y el silencio»), o uno corto con espacios. */
const DASH_PAUSE = /[\p{L}\p{N},.)][ \t]*—[ \t]*[\p{L}\p{N}¿¡(]|\p{L} – \p{L}/u;

/** Un emoji con sus modificadores y uniones, o una bandera; sin `©`, `®` ni `™`. */
const EMOJI = String.raw`(?:(?![©®™])\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|\p{Emoji_Modifier}|‍(?![©®™])\p{Extended_Pictographic}️?)*`;

/** Dos o más emojis seguidos, con o sin espacios entre ellos (no un salto de línea). */
const EMOJI_RUN = new RegExp(`${EMOJI}(?:[ \\t]*${EMOJI})+`, "gu");

/** Desde cuántos signos de exclamación es una muletilla («más de 2»). */
export const AI_TELL_MAX_EXCLAMATIONS = 2;

/**
 * El texto en minúsculas y sin tildes, **con el mismo largo** que el original (carácter a carácter),
 * para mostrar el trozo original de lo que calza. El apóstrofo tipográfico (`’`) queda como `'`.
 */
export function foldKeepingLength(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "’" || char === "‘") {
      out += "'";
      continue;
    }
    const folded = char
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
    if (folded.length === char.length) out += folded;
    else {
      const lower = char.toLowerCase();
      out += lower.length === char.length ? lower : char;
    }
  }
  return out;
}

/**
 * Las muletillas de un texto (`docs/04-formato-publicaciones.md`): las frases hechas de la lista
 * (una vez cada una, en el orden de la lista), más de 2 signos de exclamación, el guion largo como
 * pausa, las tríadas de adjetivos y los emojis seguidos. Pura; vacía si no hay ninguna. Se le pasa
 * solo el texto que se escribe (no los hashtags).
 */
export function findAiTells(text: string): AiTell[] {
  const folded = foldKeepingLength(text);
  const tells: AiTell[] = [];
  for (const { label, pattern } of PHRASE_PATTERNS) {
    if (pattern.test(folded)) tells.push({ kind: "phrase", text: label });
  }
  const exclamations = (text.match(/!/g) ?? []).length;
  if (exclamations > AI_TELL_MAX_EXCLAMATIONS) {
    tells.push({ kind: "exclamations", text: `${exclamations} signos de exclamación` });
  }
  if (DASH_PAUSE.test(text)) tells.push({ kind: "dash", text: "guion largo como pausa" });
  for (const match of folded.matchAll(TRIAD)) {
    tells.push({ kind: "triad", text: text.slice(match.index, match.index + match[0].length) });
  }
  for (const match of text.matchAll(EMOJI_RUN)) {
    tells.push({ kind: "emojis", text: match[0] });
  }
  return tells;
}

/**
 * Las muletillas del texto de un aviso, sobre lo mismo que revisa `checkContent`: el título y el
 * cuerpo, sin los hashtags. La usa también `eval:content` para contarlas.
 */
export const listingAiTells = (text: { title: string | null; body: string }): AiTell[] =>
  findAiTells([text.title ?? "", text.body].join("\n"));

/** Cómo se lee una muletilla en el mensaje de la revisión. */
function describe(tell: AiTell): string {
  switch (tell.kind) {
    case "phrase":
      return `«${tell.text}»`;
    case "triad":
      return `tres adjetivos seguidos («${tell.text}»)`;
    case "emojis":
      return `emojis seguidos (${tell.text})`;
    default:
      return tell.text;
  }
}

/** El mensaje de la advertencia `AI_TELL`, con todas las muletillas encontradas. */
export const aiTellMessage = (tells: readonly AiTell[]): string =>
  `Suena escrito por IA: ${tells.map(describe).join(", ")}. Cámbialo por algo concreto o dilo más simple`;
