import { Avatar, MoreText, PhotoGrid, PreviewFrame, PreviewVideoBox } from "./parts.js";
import { cutText, LINKEDIN_CUT, type PreviewImage, type PreviewVideo } from "./preview.js";

/**
 * Una publicación de LinkedIn: la cuenta, el texto cortado como LinkedIn (unas tres líneas) con
 * «…ver más», y la imagen, las imágenes en grilla o el video. Se ve el texto como lo lee la gente:
 * los escapes que exige LinkedIn (`escapeLinkedInText`) no se ven.
 */
export function LinkedInPreview({
  label,
  accountName,
  text,
  images,
  video,
  draft = false,
}: {
  label: string;
  accountName: string;
  text: string;
  images: readonly PreviewImage[];
  video: PreviewVideo | null;
  draft?: boolean;
}) {
  return (
    <PreviewFrame label={label} network="LinkedIn" draft={draft}>
      <article className="max-w-lg overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2 px-3 pt-3">
          <Avatar name={accountName} className="size-10" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{accountName}</p>
            <p className="text-xs text-fg-subtle">Ahora</p>
          </div>
        </div>
        <MoreText
          text={text}
          short={cutText(text, LINKEDIN_CUT)}
          more="ver más"
          separator=""
          className="px-3 py-2 text-sm text-fg"
        />
        {video !== null ? (
          <PreviewVideoBox
            video={video}
            label="Video de la publicación en LinkedIn"
            className="aspect-video w-full"
          />
        ) : (
          <PhotoGrid
            images={images}
            alt={(index, total) => `Imagen ${index + 1} de ${total} de la publicación en LinkedIn`}
          />
        )}
      </article>
    </PreviewFrame>
  );
}
