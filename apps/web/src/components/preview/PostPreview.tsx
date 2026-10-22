import type { PostMediaItem } from "@agentsales/api/contracts";
import { type PostKind, type PostPlatform, socialCaption } from "@agentsales/core";
import { DiscordPreview } from "./DiscordPreview.js";
import { InstagramPostPreview, InstagramReelPreview } from "./InstagramPreview.js";
import { LinkedInPreview } from "./LinkedInPreview.js";
import { type PreviewText, postPreviewMedia } from "./preview.js";
import { TikTokPreview } from "./TikTokPreview.js";
import { XPreview } from "./XPreview.js";

/**
 * La vista previa de un post en una red (F9.5-T07): el texto como se envía (`socialCaption`: con
 * los hashtags, salvo en Discord) y los medios que elige el publisher (`postPreviewMedia`), en la
 * forma de esa red.
 */
export function PostPreview({
  label,
  platform,
  kind,
  media,
  text,
  accountName,
  draft = false,
}: {
  label: string;
  platform: PostPlatform;
  kind: PostKind;
  media: readonly PostMediaItem[];
  text: Pick<PreviewText, "body" | "hashtags">;
  accountName: string;
  draft?: boolean;
}) {
  const { images, video } = postPreviewMedia(platform, kind, media);
  const caption = socialCaption(platform, { body: text.body, hashtags: [...text.hashtags] });
  const common = { label, accountName, draft };
  switch (platform) {
    case "instagram":
      if (kind === "video" && video !== null) {
        return <InstagramReelPreview {...common} video={video} text={text} />;
      }
      return (
        <InstagramPostPreview
          {...common}
          images={images}
          text={text}
          noMedia={
            kind === "text"
              ? "Instagram necesita una imagen o un video."
              : kind === "video"
                ? "Sin video todavía."
                : "Sin imágenes todavía."
          }
        />
      );
    case "x":
      return <XPreview {...common} text={caption} images={images} video={video} />;
    case "linkedin":
      return <LinkedInPreview {...common} text={caption} images={images} video={video} />;
    case "discord":
      return <DiscordPreview {...common} text={caption} images={images} video={video} />;
    case "tiktok":
      return <TikTokPreview {...common} text={caption} video={video} />;
  }
}
