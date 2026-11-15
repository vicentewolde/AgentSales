import type { PostMediaItem } from "@agentsales/api/contracts";
import { type Language, type PostKind, type PostPlatform, socialCaption } from "@agentsales/core";
import { DiscordPreview } from "./DiscordPreview.js";
import { InstagramPostPreview, InstagramReelPreview } from "./InstagramPreview.js";
import { LinkedInPreview } from "./LinkedInPreview.js";
import {
  mediaForText,
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
  /**
   * El idioma del texto: lleva las tarjetas de su idioma (F9.5) y las fotos de su idioma (ADR-0042;
   * en Instagram, todas, primero las de su idioma).
   */
  language: Language;
  text: Pick<PreviewText, "body" | "hashtags">;
  accountName: string;
  draft?: boolean;
}) {
  const { images, video, problem } = postPreviewMedia(
    platform,
    kind,
    mediaForText(media, platform, language),
    language,
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
      {/* F9.7 B9: lo que cada red le hace a las imágenes, para decidir antes de publicar. */}
      {platform === "x" && images.length >= 2 && video === null && (
        <p
          role="note"
          className="rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm text-fg-muted"
        >
          X muestra {images.length > 4 ? "solo 4 imágenes" : `las ${images.length} imágenes`} en una
          cuadrícula que recorta cada una (arriba y abajo, como abajo). Si las láminas tienen texto,
          se cortará: conviene publicarlo como hilo, una lámina por post.
        </p>
      )}
      {platform === "linkedin" && kind === "carousel" && images.length >= 2 && video === null && (
        <p
          role="note"
          className="rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm text-fg-muted"
        >
          LinkedIn pone varias imágenes en una cuadrícula recortada. Para que se vea como carrusel,
          usa «Descargar PDF para LinkedIn» (en «Láminas») y súbelo como documento.
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
      {platform === "instagram" && images[0] !== undefined && video === null && (
        <ProfileGrid image={images[0]} />
      )}
    </div>
  );
}

/**
 * Cómo se ve la primera imagen en la cuadrícula del perfil de Instagram (B9): recortada a 3:4 en la
 * primera de tres columnas, junto a dos casillas de posts anteriores.
 */
function ProfileGrid({ image }: { image: PreviewImage }) {
  return (
    <figure className="max-w-xs">
      <figcaption className="mb-1 text-xs text-fg-subtle">En la cuadrícula de tu perfil</figcaption>
      <div className="grid grid-cols-3 gap-0.5" aria-hidden="true">
        <div className="aspect-[3/4] overflow-hidden bg-sand">
          {image.src !== null && <img src={image.src} alt="" className="size-full object-cover" />}
        </div>
        <div className="aspect-[3/4] bg-sand" />
        <div className="aspect-[3/4] bg-sand" />
      </div>
    </figure>
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
