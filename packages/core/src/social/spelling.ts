import type { Language } from "../enums.js";

// La ortografía de los textos editados a mano (spec F9.7 B8, ADR-0043): una lista acotada de
// errores frecuentes, sin ambigüedad, por idioma, con su corrección. Es un aviso (`SPELLING`), no
// un error. Se eligió una lista y no un diccionario completo (hunspell pesa varios MB y marca
// nombres propios y anglicismos de marca como errores) ni una llamada a la IA (gasta por cada
// guardado): la lista cubre lo que más se escapa al escribir rápido, sin falsos positivos.

const ES: Readonly<Record<string, string>> = {
  tambien: "también",
  despues: "después",
  ademas: "además",
  todavia: "todavía",
  facil: "fácil",
  dificil: "difícil",
  rapido: "rápido",
  rapidamente: "rápidamente",
  informacion: "información",
  publicacion: "publicación",
  aplicacion: "aplicación",
  tecnologia: "tecnología",
  economia: "economía",
  compania: "compañía",
  telefono: "teléfono",
  pagina: "página",
  codigo: "código",
  numero: "número",
  ultimo: "último",
  ultima: "última",
  proximo: "próximo",
  proxima: "próxima",
  ningun: "ningún",
  algun: "algún",
  segun: "según",
  demas: "demás",
  aqui: "aquí",
  alli: "allí",
  asi: "así",
  aveces: "a veces",
  osea: "o sea",
  enserio: "en serio",
  porfavor: "por favor",
  atravez: "a través",
  atraves: "a través",
  hechar: "echar",
  haiga: "haya",
  nadien: "nadie",
  exelente: "excelente",
  ecepto: "excepto",
  interezante: "interesante",
  dijistes: "dijiste",
  fuistes: "fuiste",
  hicistes: "hiciste",
  preveer: "prever",
  inflacción: "inflación",
  excepcion: "excepción",
  decision: "decisión",
  solucion: "solución",
  comision: "comisión",
};

const EN: Readonly<Record<string, string>> = {
  teh: "the",
  recieve: "receive",
  seperate: "separate",
  definately: "definitely",
  occured: "occurred",
  untill: "until",
  wich: "which",
  becuase: "because",
  accomodate: "accommodate",
  acheive: "achieve",
  adress: "address",
  begining: "beginning",
  beleive: "believe",
  calender: "calendar",
  comming: "coming",
  commited: "committed",
  concious: "conscious",
  embarass: "embarrass",
  enviroment: "environment",
  existance: "existence",
  goverment: "government",
  greatful: "grateful",
  independant: "independent",
  knowlege: "knowledge",
  neccessary: "necessary",
  noticable: "noticeable",
  occassion: "occasion",
  persistant: "persistent",
  posession: "possession",
  publically: "publicly",
  realy: "really",
  recomend: "recommend",
  refered: "referred",
  relevent: "relevant",
  succesful: "successful",
  tommorow: "tomorrow",
  truely: "truly",
  wierd: "weird",
  alot: "a lot",
  thier: "their",
  freind: "friend",
  buisness: "business",
};

const LISTS: Readonly<Record<Language, Readonly<Record<string, string>>>> = { es: ES, en: EN };

/** Las palabras mal escritas de un texto en su idioma, con su corrección, sin repetir. */
export function misspellings(
  text: string,
  language: Language,
): { word: string; suggestion: string }[] {
  const list = LISTS[language];
  const found: { word: string; suggestion: string }[] = [];
  const seen = new Set<string>();
  // Fuera enlaces, menciones y hashtags: no son palabras del texto.
  const prose = text.replace(/https?:\/\/\S+|[@#][\p{L}\p{N}_]+/gu, " ");
  for (const word of prose.match(/[\p{L}]+/gu) ?? []) {
    const key = word.toLowerCase();
    const suggestion = list[key];
    if (suggestion === undefined || seen.has(key)) continue;
    seen.add(key);
    found.push({ word, suggestion });
  }
  return found;
}
