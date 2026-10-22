import type { PostJson, PostMediaItem } from "@agentsales/api/contracts";
import { useUpdatePost } from "../../queries/posts.js";
import { MusicPicker } from "../music/MusicPicker.js";

/**
 * «Música del reel» de un post (F9.5-T19): solo si tiene un video (o ya eligió una pista). Cambiarla
 * guarda con `PATCH /posts/:id` y el worker rehace sus videos (reel, X y Discord) con la pista.
 */
export function PostMusic({
  post,
  media,
  lockReason,
}: {
  post: PostJson;
  media: readonly PostMediaItem[];
  lockReason: string | null;
}) {
  const update = useUpdatePost(post.id);
  if (post.musicTrackId === null && !media.some((item) => item.kind === "video")) return null;
  const pending = update.isPending && update.variables?.musicTrackId !== undefined;
  return (
    <MusicPicker
      label="Música del reel"
      value={pending ? (update.variables?.musicTrackId ?? null) : post.musicTrackId}
      onChange={(musicTrackId) => update.mutate({ musicTrackId })}
      disabled={lockReason !== null}
      saving={pending}
      error={update.error}
      after="Al cambiarla, los videos del post se rehacen solos en unos minutos, para todas las redes."
    />
  );
}
