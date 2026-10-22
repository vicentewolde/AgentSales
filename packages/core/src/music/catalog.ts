import { z } from "zod";
import { AppError } from "../errors.js";

// La biblioteca de música de los reels (F9.5-T19, `docs/integraciones/musica-reels.md`). Solo pistas
// CC0 (decisión del operador del 2026-10-22): no piden crédito, así que ningún texto lleva
// atribución. Los archivos no van en git: el operador los baja, los escucha, los aprueba y los
// sube a R2 con `pnpm music:upload <carpeta>` (cada uno como `<id>.mp3`). Una pista del catálogo
// que no está en R2 no rompe nada: el reel sale sin música y la corrida lo avisa.

/** Los estilos con que el panel y la CLI describen una pista. */
export const MUSIC_STYLES = ["calm", "upbeat", "elegant", "acoustic", "modern"] as const;
export type MusicStyle = (typeof MUSIC_STYLES)[number];

/** Las licencias aceptadas: solo CC0 (sin crédito). Otra licencia pide una decisión nueva. */
export const MUSIC_LICENSES = ["CC0-1.0"] as const;
export type MusicLicense = (typeof MUSIC_LICENSES)[number];

/** Los ids de las pistas: van en la base (`music_track_id`) y en la clave de R2 del reel. */
export const MUSIC_TRACK_IDS = [
  "calm-piano",
  "sunny-side-up",
  "champ-de-tournesol",
  "serenade-guitar",
  "up-in-the-sky",
] as const;
export type MusicTrackId = (typeof MUSIC_TRACK_IDS)[number];

export type MusicTrack = {
  id: MusicTrackId;
  title: string;
  author: string;
  style: MusicStyle;
  license: MusicLicense;
  /** La página de origen con la licencia (la evidencia que guarda el operador). */
  sourceUrl: string;
};

/** El catálogo, en el orden en que se muestra. */
export const MUSIC_TRACKS: readonly MusicTrack[] = [
  {
    id: "calm-piano",
    title: "Calm Piano 1 (Vaporware)",
    author: "cynicmusic",
    style: "calm",
    license: "CC0-1.0",
    sourceUrl: "https://opengameart.org/content/calm-piano-1-vaporware",
  },
  {
    id: "sunny-side-up",
    title: "Sunny Side Up",
    author: "Alex McCulloch (Pro Sensory)",
    style: "upbeat",
    license: "CC0-1.0",
    sourceUrl: "https://opengameart.org/content/sunny-side-up-updated-version",
  },
  {
    id: "champ-de-tournesol",
    title: "Champ de tournesol",
    author: "Komiku",
    style: "acoustic",
    license: "CC0-1.0",
    sourceUrl: "https://opengameart.org/content/champ-de-tournesol",
  },
  {
    id: "serenade-guitar",
    title: "Serenade Guitar",
    author: "Alex McCulloch (Pro Sensory)",
    style: "elegant",
    license: "CC0-1.0",
    sourceUrl: "https://opengameart.org/content/serenade-guitar",
  },
  {
    id: "up-in-the-sky",
    title: "Up in the Sky",
    author: "Memoraphile",
    style: "modern",
    license: "CC0-1.0",
    sourceUrl: "https://opengameart.org/content/up-in-the-sky",
  },
];

/** El texto de un estilo para el panel y la CLI (con mayúscula inicial). */
export const MUSIC_STYLE_TEXT: Readonly<Record<MusicStyle, string>> = {
  calm: "Tranquila",
  upbeat: "Alegre",
  elegant: "Elegante",
  acoustic: "Acústica",
  modern: "Moderna",
};

/** Lo que se muestra cuando no hay música (el valor por defecto). */
export const NO_MUSIC_TEXT = "Sin música";

/** Un id del catálogo (para validar en los bordes: API y CLI). */
export const musicTrackIdSchema = z.enum(MUSIC_TRACK_IDS);

/** La clave de R2 de una pista: privada, fuera de las de un corredor. */
export const musicTrackPath = (id: MusicTrackId) => `assets/musica/${id}.mp3`;

/** La pista del catálogo, o `null` si el id no está (por ejemplo, una que se sacó después). */
export function musicTrackOf(id: string | null | undefined): MusicTrack | null {
  if (id === null || id === undefined) return null;
  return MUSIC_TRACKS.find((track) => track.id === id) ?? null;
}

/**
 * Valida la pista que se elige (API y core): `null` es «sin música»; otro id que no esté en el
 * catálogo es `MUSIC_TRACK_INVALID` (400).
 */
export function checkMusicTrackId(id: string | null): MusicTrackId | null {
  if (id === null) return null;
  const track = musicTrackOf(id);
  if (track === null) {
    throw new AppError("MUSIC_TRACK_INVALID", `No existe la pista de música «${id}»`, {
      details: { musicTrackId: id },
    });
  }
  return track.id;
}

/** «Calm Piano 1 (Vaporware) · Tranquila», o «Sin música». */
export function musicTrackText(id: string | null | undefined): string {
  if (id === null || id === undefined) return NO_MUSIC_TEXT;
  const track = musicTrackOf(id);
  return track === null ? id : `${track.title} · ${MUSIC_STYLE_TEXT[track.style]}`;
}
