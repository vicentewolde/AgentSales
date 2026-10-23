import type { PostMediaItem } from "@agentsales/api/contracts";
import { type Language, type PostKind, type PostPlatform, socialCaption } from "@agentsales/core";
import { DiscordPreview } from "./DiscordPreview.js";
import { InstagramPostPreview, InstagramReelPreview } from "./InstagramPreview.js";
import { LinkedInPreview } from "./LinkedInPreview.js";
import {
  mediaForLanguage,
  type PreviewImage,
  type PreviewText,
  type PreviewVideo,
  postPreviewMedia,
} from "./preview.js";
import { TikTokPreview } from "./TikTokPreview.js";
import { XPreview } from "./XPreview.js";

/**
 * La vista previa de un post en una red (F9.5-T07): el texto como se envía (`socialCaption`: con
 * los hashtags, salvo en Discord) y los medios que elige el publisher (`postPreviewMedia`), en la
 * forma de esa red, con el aviso de lo que el publisher rechazaría por los medios.
 */
export function PostPreview({
  label,
  platform,
  kind,
  media,
  language,
  text,
  accountName,
  draft = false,
}: {
  label: string;
  platform: PostPlatform;
  kind: PostKind;
  media: readonly PostMediaItem[];
  /** El idioma del texto: lleva las tarjetas de su idioma (F9.5, tarjetas por idioma). */
  language: Language;
  text: Pick<PreviewText, "body" | "hashtags">;
  accountName: string;
  draft?: boolean;
}) {
  const { images, video, problem } = postPreviewMedia(
    platform,
    kind,
    mediaForLanguage(media, language),
  );
  return (
    <div className="space-y-2">
      {problem !== null && (
        <p
          role="note"
          className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800"
        >
          {problem}
        </p>
      )}
      <NetworkView
        label={label}
        platform={platform}
        kind={kind}
        images={images}
        video={video}
        text={text}
        accountName={accountName}
        draft={draft}
      />
    </div>
  );
}

/** La vista de la red, con los medios ya elegidos. */
function NetworkView({
  label,
  platform,
  kind,
  images,
  video,
  text,
  accountName,
  draft,
}: {
  label: string;
  platform: PostPlatform;
  kind: PostKind;
  images: readonly PreviewImage[];
  video: PreviewVideo | null;
  text: Pick<PreviewText, "body" | "hashtags">;
  accountName: string;
  draft: boolean;
}) {
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
              ? "Sin imagen ni video."
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
