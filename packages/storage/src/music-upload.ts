import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type MediaStorage,
  MUSIC_TRACK_IDS,
  type MusicTrackId,
  musicTrackOf,
  musicTrackPath,
} from "@agentsales/core";

// `pnpm music:upload <carpeta>` (F9.5-T19): sube a R2 las pistas que el operador bajó, escuchó y
// aprobó. Cada archivo se llama como el id de su pista en el catálogo (`calm-piano.mp3`) y tiene
// que ser un MP3 de verdad; lo demás se informa y no se sube. Nada se borra en R2.

/** Tope de una pista (las del catálogo pesan menos de 10 MB como MP3). */
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024;

export type MusicUploadOutcome =
  | { file: string; trackId: MusicTrackId; status: "uploaded"; bytes: number; sha256: string }
  | {
      file: string;
      status: "rejected";
      reason: "unknown_track" | "not_mp3" | "too_large" | "empty" | "not_a_file";
    };

export type MusicUploadReport = {
  outcomes: MusicUploadOutcome[];
  /** Las pistas del catálogo que no vinieron en la carpeta (siguen como estaban en R2). */
  missing: MusicTrackId[];
};

/**
 * Si los bytes son un MP3: con etiqueta ID3 al inicio, o un cuadro MPEG (11 bits de
 * sincronización, capa III). No decodifica: solo evita subir otra cosa con el nombre de una pista.
 */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // "ID3"
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  // 0xFFE (sincronización) y capa III (bits 2-1 de `second` = 01).
  return first === 0xff && (second & 0xe0) === 0xe0 && (second & 0x06) === 0x02;
}

/** Sube las pistas de `dir` (sin subcarpetas); devuelve qué pasó con cada archivo. */
export async function uploadMusicFolder(
  storage: Pick<MediaStorage, "put">,
  dir: string,
): Promise<MusicUploadReport> {
  const names = (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
  const outcomes: MusicUploadOutcome[] = [];
  const uploaded = new Set<MusicTrackId>();
  for (const file of names) {
    const path = join(dir, file);
    const info = await stat(path);
    if (!info.isFile()) {
      outcomes.push({ file, status: "rejected", reason: "not_a_file" });
      continue;
    }
    const match = /^(.+)\.mp3$/i.exec(file);
    const track = match === null ? null : musicTrackOf(match[1]);
    if (track === null) {
      outcomes.push({ file, status: "rejected", reason: "unknown_track" });
      continue;
    }
    if (info.size === 0) {
      outcomes.push({ file, status: "rejected", reason: "empty" });
      continue;
    }
    if (info.size > MUSIC_MAX_BYTES) {
      outcomes.push({ file, status: "rejected", reason: "too_large" });
      continue;
    }
    const bytes = await readFile(path);
    if (!looksLikeMp3(bytes)) {
      outcomes.push({ file, status: "rejected", reason: "not_mp3" });
      continue;
    }
    await storage.put(musicTrackPath(track.id), bytes, "audio/mpeg");
    uploaded.add(track.id);
    outcomes.push({
      file,
      trackId: track.id,
      status: "uploaded",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { outcomes, missing: MUSIC_TRACK_IDS.filter((id) => !uploaded.has(id)) };
}

const REASON_TEXT: Record<Extract<MusicUploadOutcome, { status: "rejected" }>["reason"], string> = {
  unknown_track: `el nombre no es una pista del catálogo (${MUSIC_TRACK_IDS.map((id) => `${id}.mp3`).join(", ")})`,
  not_mp3:
    "no es un MP3 (convierte el WAV u OGG con ffmpeg: ver docs/integraciones/musica-reels.md)",
  too_large: `pesa más de ${MUSIC_MAX_BYTES / 1024 / 1024} MB`,
  empty: "está vacío",
  not_a_file: "no es un archivo",
};

/** El informe para la terminal, una línea por archivo y la lista de las que faltan. */
export function musicUploadText(report: MusicUploadReport): string {
  const lines = report.outcomes.map((outcome) =>
    outcome.status === "uploaded"
      ? `✓ ${outcome.file} → ${musicTrackPath(outcome.trackId)} (${(outcome.bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${outcome.sha256})`
      : `✗ ${outcome.file}: ${REASON_TEXT[outcome.reason]}`,
  );
  if (report.outcomes.length === 0) lines.push("La carpeta no tiene archivos.");
  if (report.missing.length > 0) {
    lines.push(
      `No vinieron (quedan como estaban en R2; sin archivo, el reel sale sin música): ${report.missing.join(", ")}`,
    );
  }
  return lines.join("\n");
}
