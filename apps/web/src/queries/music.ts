import { musicTrackListResponseSchema } from "@agentsales/api/contracts";
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

/**
 * La URL para escuchar una pista dura 10 min (`MUSIC_PREVIEW_TTL_SECONDS` de la API): la lista se
 * considera fresca 5 min y se descarta a los 8 sin uso, antes de que venza.
 */
const MUSIC_STALE_MS = 5 * 60 * 1000;
const MUSIC_GC_MS = 8 * 60 * 1000;

export const musicKeys = { tracks: ["music", "tracks"] as const };

/** `GET /music/tracks` (F9.5-T19): la biblioteca de música de los reels. */
export function useMusicTracks() {
  const client = useApiClient();
  return useQuery({
    queryKey: musicKeys.tracks,
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.music.tracks.$get(undefined, { init: { signal } }),
          musicTrackListResponseSchema,
        )
      ).tracks,
    staleTime: MUSIC_STALE_MS,
    gcTime: MUSIC_GC_MS,
  });
}
