import type { EditorialProfileView } from "../editorial-profile.js";
import { foldText } from "../listing-validator/normalizers.js";

// La voz de la marca (F9.5-T23): «nosotros» solo si la marca es un equipo. La usan las ideas del plan
// (la regla del prompt y el descarte `FIRST_PERSON_PLURAL`) y los textos de los posts (la regla del
// prompt, `es_equipo`). Sin dependencias de `plan.ts` ni de `brief.ts`, para que ambos la importen.

/**
 * Las palabras de primera persona del plural que la verificación reconoce (plegadas: sin tildes ni
 * mayúsculas): pronombres y posesivos en español e inglés. Los verbos («aprendimos», «trabajamos»)
 * no se reconocen: confundirían «últimos» o «ramos»; quedan a cargo de la regla del prompt. Tampoco
 * «us» en inglés: plegado a minúsculas es igual a «US» y a «US$» (dólares), que salen en textos de
 * precios y costos.
 */
const FIRST_PERSON_PLURAL: ReadonlySet<string> = new Set([
  "nosotros",
  "nosotras",
  "nuestro",
  "nuestra",
  "nuestros",
  "nuestras",
  "nos",
  "we",
  "our",
  "ours",
  "ourselves",
]);

/** Lo que dice, en un hecho del perfil, que la marca es un equipo. */
const TEAM_WORDS: ReadonlySet<string> = new Set([
  ...FIRST_PERSON_PLURAL,
  "equipo",
  "somos",
  "team",
]);

/**
 * Las palabras de un texto, plegadas y en minúsculas. El apóstrofo separa («we're» → «we» y «re»,
 * «let's» → «let» y «s»): así una contracción no esconde el pronombre.
 */
const foldedWords = (text: string): string[] =>
  foldText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

/**
 * `true` si un **hecho** del perfil dice que la marca es un equipo («Somos un equipo de 4
 * corredores», «Nuestra oficina…», «We are a team…»): solo entonces las ideas y los textos pueden
 * hablar de «nosotros». Se miran los hechos porque son lo que la IA puede afirmar (ADR-0030, punto 1).
 */
export function profileSpeaksAsTeam(profile: Pick<EditorialProfileView, "facts">): boolean {
  return profile.facts.some((fact) => foldedWords(fact).some((word) => TEAM_WORDS.has(word)));
}

/** Las palabras de primera persona del plural de un texto, sin repetir y como aparecen plegadas. */
export function firstPersonPluralWords(text: string): string[] {
  return [...new Set(foldedWords(text).filter((word) => FIRST_PERSON_PLURAL.has(word)))];
}
