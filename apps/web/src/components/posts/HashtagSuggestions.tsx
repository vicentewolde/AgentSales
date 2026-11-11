import type { PostPlatform } from "@agentsales/core";
import { useContext } from "react";
import { SubjectBrokerContext } from "../../queries/health.js";
import { useEditorialProfile } from "../../queries/posts.js";
import { parseHashtags } from "../content/editor.js";

/**
 * Cuántos hashtags conviene usar en cada red (guía, no regla): en X uno o dos, porque cada uno
 * quita caracteres y se ve como spam; en Instagram, de 3 a 5 bien elegidos; en LinkedIn, 3.
 */
export const HASHTAG_ADVICE: Readonly<Record<PostPlatform, string>> = {
  x: "En X, 1 o 2 como máximo.",
  instagram: "En Instagram, de 3 a 5 que alguien buscaría.",
  linkedin: "En LinkedIn, unos 3.",
  discord: "En Discord casi no se usan.",
  tiktok: "En TikTok, de 3 a 5.",
};

// Palabras con mayúscula que no sirven de hashtag (comienzo de frase, pronombres, conectores).
const STOP = new Set(
  [
    "a",
    "an",
    "and",
    "the",
    "this",
    "that",
    "with",
    "for",
    "every",
    "everything",
    "our",
    "we",
    "you",
    "your",
    "it",
    "if",
    "in",
    "on",
    "by",
    "to",
    "of",
    "is",
    "are",
    "be",
    "building",
    "thank",
    "thanks",
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "con",
    "por",
    "para",
    "que",
    "cada",
    "todo",
    "tu",
    "tú",
    "si",
    "en",
    "de",
    "del",
    "y",
    "o",
    "gracias",
    "por",
    "ahora",
    "hoy",
  ].map((word) => word.toLowerCase()),
);

/**
 * Hashtags sugeridos para un texto, sin IA ni costo: primero los del perfil de la marca y después
 * los nombres propios y siglas del texto (Stellar, USDC, MCP…), sin repetir los que ya tiene ni
 * las palabras comunes. Como mucho `max`.
 */
export function suggestHashtags(
  body: string,
  brandDefaults: readonly string[],
  current: readonly string[],
  max = 8,
): string[] {
  const taken = new Set(current.map((tag) => tag.toLowerCase()));
  const out: string[] = [];
  const push = (tag: string) => {
    const key = tag.toLowerCase();
    if (taken.has(key) || out.includes(key)) return;
    // En minúsculas: así quedan guardados (`normalizeHashtags`).
    out.push(key);
  };
  for (const tag of parseHashtags(brandDefaults.join(" "))) push(tag);
  // Sin URLs, menciones ni hashtags del cuerpo; cada palabra con su mayúscula original.
  const clean = body.replace(/https?:\/\/\S+|[@#][\p{L}\p{N}_.-]+|\S+\.\S+\/\S*/gu, " ");
  const sentences = clean.split(/(?<=[.!?¡¿:\n])\s+/u);
  for (const sentence of sentences) {
    const words = sentence.match(/[\p{L}\p{N}]+/gu) ?? [];
    words.forEach((word, index) => {
      if (word.length < 2 || STOP.has(word.toLowerCase())) return;
      const acronym = /^[\p{Lu}\p{N}]{2,6}$/u.test(word) && /\p{Lu}/u.test(word);
      // Un nombre propio: con mayúscula y no al comienzo de la frase (o con otra mayúscula dentro: ChatGPT, AgentPey).
      const proper =
        /^\p{Lu}/u.test(word) && (index > 0 || /\p{Lu}/u.test(word.slice(1))) && word.length > 2;
      if (acronym || proper) push(`#${word}`);
    });
  }
  return out.slice(0, max);
}

/** Los hashtags sugeridos como botones que se agregan al campo, con la guía de cuántos usar. */
export function HashtagSuggestions({
  platform,
  body,
  hashtags,
  onAdd,
}: {
  platform: PostPlatform;
  body: string;
  hashtags: string;
  onAdd: (tag: string) => void;
}) {
  const brokerId = useContext(SubjectBrokerContext);
  const profile = useEditorialProfile(brokerId);
  const current = parseHashtags(hashtags);
  const suggestions = suggestHashtags(body, profile.data?.defaultHashtags ?? [], current);
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-fg-muted">
        {HASHTAG_ADVICE[platform]}{" "}
        {suggestions.length > 0
          ? "Sugeridos (toca para agregar):"
          : "No tengo sugerencias para este texto."}
      </p>
      {suggestions.length > 0 && (
        <ul aria-label="Hashtags sugeridos" className="flex flex-wrap gap-1.5">
          {suggestions.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => onAdd(tag)}
                aria-label={`Agregar ${tag}`}
                className="min-h-9 rounded-full border border-dashed border-brand-300 bg-brand-50 px-3 text-sm text-brand-800 hover:bg-brand-100 focus-visible:outline-2 focus-visible:outline-brand-700 pointer-coarse:min-h-11"
              >
                <span aria-hidden="true">+ </span>
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
