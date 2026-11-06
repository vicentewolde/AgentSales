/**
 * Spanish number words to numbers, so a statement like "common expenses 42000" can be checked against
 * the broker's words ("cuarenta y dos mil"). The risk it guards is a model that mishears or
 * misconverts a figure: every number in a voice claim must be derivable from its own quote.
 */
const UNITS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
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
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};
const TENS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};
const HUNDREDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  doscientos: 200,
  doscientas: 200,
  trescientos: 300,
  trescientas: 300,
  cuatrocientos: 400,
  cuatrocientas: 400,
  quinientos: 500,
  quinientas: 500,
  seiscientos: 600,
  seiscientas: 600,
  setecientos: 700,
  setecientas: 700,
  ochocientos: 800,
  ochocientas: 800,
  novecientos: 900,
  novecientas: 900,
};

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Every number the text expresses, as digits or Spanish words (0 to 999,999,999). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const words =
    stripAccents(text.toLowerCase())
      .replace(/(\d)[.,](?=\d{3}\b)/g, "$1")
      .match(/\d+|[a-z]+/g) ?? [];
  let total = 0;
  let current = 0;
  let any = false;
  const flush = () => {
    if (any) out.add(total + current);
    total = 0;
    current = 0;
    any = false;
  };
  for (const w of words) {
    if (/^\d+$/.test(w)) {
      flush();
      out.add(Number(w));
    } else if (w in UNITS) {
      current += UNITS[w] as number;
      any = true;
    } else if (w in TENS) {
      current += TENS[w] as number;
      any = true;
    } else if (w in HUNDREDS) {
      current += HUNDREDS[w] as number;
      any = true;
    } else if (w === "mil" && any) {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
    } else if ((w === "millon" || w === "millones") && any) {
      total += current * 1_000_000;
      current = 0;
    } else if (w === "y" && any) {
      // "cuarenta y dos": keep accumulating
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Digits that appear in a statement (thousands separators removed). */
export function digitsIn(text: string): number[] {
  return (text.replace(/(\d)[.,](?=\d{3}\b)/g, "$1").match(/\d+/g) ?? []).map(Number);
}
