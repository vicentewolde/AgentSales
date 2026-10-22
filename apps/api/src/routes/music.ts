import { type MediaStorage, MUSIC_TRACKS, musicTrackPath } from "@agentsales/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import type { MusicTrackListResponse } from "../contracts/index.js";

/** La vida de la URL para escuchar una pista en el panel: corta, solo para el reproductor. */
export const MUSIC_PREVIEW_TTL_SECONDS = 600;

export type MusicRoutesDeps = {
  /** Si la pista está en R2 y la URL firmada para escucharla (R2 es privado, ADR-0007). */
  storage: Pick<MediaStorage, "head" | "signedReadUrl">;
};

/**
 * `/music` (F9.5-T19): la biblioteca de música de los reels. Cualquier usuario con sesión la ve
 * (el catálogo es el mismo para todos); elegir una pista es de la propiedad o del post.
 */
export function musicRoutes(deps: MusicRoutesDeps) {
  return new Hono<AppEnv>().get("/tracks", async (c) => {
    const tracks = await Promise.all(
      MUSIC_TRACKS.map(async (track) => {
        const path = musicTrackPath(track.id);
        const available = (await deps.storage.head(path)) !== null;
        return {
          ...track,
          available,
          previewUrl: available
            ? await deps.storage.signedReadUrl(path, MUSIC_PREVIEW_TTL_SECONDS)
            : null,
        };
      }),
    );
    const body: MusicTrackListResponse = { tracks };
    return c.json(body, 200);
  });
}
