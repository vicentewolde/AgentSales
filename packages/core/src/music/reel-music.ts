import type { MusicInput } from "../ports/media-processor.js";
import type { MediaStorage } from "../ports/media-storage.js";
import { type MusicTrack, musicTrackOf, musicTrackPath } from "./catalog.js";

/**
 * La música de un reel ya resuelta (F9.5-T19): la pista del catálogo, que está en R2, y cómo leerla
 * (una sola vez, cuando hace falta armar algo).
 */
export type ReelMusic = { track: MusicTrack; input: () => Promise<MusicInput> };

/**
 * La música elegida de una propiedad o un post, si se puede usar. Sin pista (`null`) no hay música
 * ni aviso. Una pista que ya no está en el catálogo, o que el operador todavía no subió a R2
 * (`pnpm music:upload`), no falla: el reel sale sin música y vuelve `warning`, para la corrida.
 * Un error de R2 que no sea «no existe» sube (el job reintenta).
 */
export async function resolveReelMusic(
  storage: Pick<MediaStorage, "head" | "get">,
  trackId: string | null,
): Promise<{ music: ReelMusic | null; warning: string | null }> {
  if (trackId === null) return { music: null, warning: null };
  const track = musicTrackOf(trackId);
  if (track === null) {
    return {
      music: null,
      warning: `La música elegida («${trackId}») ya no está en la biblioteca: el reel queda sin música`,
    };
  }
  const path = musicTrackPath(track.id);
  if ((await storage.head(path)) === null) {
    return {
      music: null,
      warning: `La música «${track.title}» todavía no está subida a la biblioteca: el reel queda sin música (la sube el administrador con pnpm music:upload)`,
    };
  }
  let read: Promise<MusicInput> | null = null;
  return {
    music: {
      track,
      input: () => {
        read ??= storage.get(path).then((bytes) => ({ bytes }));
        return read;
      },
    },
    warning: null,
  };
}
