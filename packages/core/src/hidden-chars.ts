// Los caracteres que un texto del operador no puede traer porque viaja al prompt de la IA (el perfil
// editorial, ADR-0030, y el pedido de un plan, F9.5-T23): esconderían texto, lo invertirían o
// partirían una línea sin que se vea. Una sola lista para los dos, así no se separan.
//
// - controles C0 (salvo el salto de línea `\n`, que cada texto decide si acepta) y C1, y DEL;
// - separadores de línea y de párrafo Unicode (U+2028, U+2029);
// - controles bidireccionales: incrustaciones y anulaciones (U+202A a U+202E), aislamientos (U+2066 a
//   U+2069), las marcas de dirección (U+200E, U+200F) y la marca de letra árabe (U+061C);
// - los de ancho cero (U+200B a U+200D, U+2060 y U+FEFF).

export const HIDDEN_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: justamente los que se rechazan
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u200b-\u200d\u2060\ufeff]/;

/**
 * `true` si el texto trae un carácter escondido (`HIDDEN_CHARS`); con `allowNewline: false`,
 * también si trae un salto de línea.
 */
export function hasHiddenChars(text: string, options: { allowNewline: boolean }): boolean {
  return HIDDEN_CHARS.test(text) || (!options.allowNewline && text.includes("\n"));
}
