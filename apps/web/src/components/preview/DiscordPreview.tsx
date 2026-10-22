import { Avatar, PreviewFrame, PreviewPhoto, PreviewVideoBox } from "./parts.js";
import type { PreviewImage, PreviewVideo } from "./preview.js";

/**
 * Un mensaje del webhook en el canal de Discord: el nombre del webhook con la etiqueta APP, el
 * texto entero (sin hashtags: en Discord no se envían) y los adjuntos debajo.
 */
export function DiscordPreview({
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
    <PreviewFrame label={label} network="Discord" draft={draft}>
      <article className="flex max-w-lg gap-3 rounded-lg border border-line bg-slate-50 p-3">
        <Avatar name={accountName} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-semibold text-fg">{accountName}</span>
            <span className="rounded bg-brand-600 px-1 text-[0.625rem] font-semibold text-white">
              APP
            </span>
            <span className="text-xs text-fg-subtle">hoy</span>
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">{text}</p>
          {video !== null && (
            <PreviewVideoBox
              video={video}
              label="Video adjunto en Discord"
              className="mt-2 aspect-video w-full max-w-sm rounded-md"
            />
          )}
          {images.length > 0 && (
            <ul className="mt-2 grid max-w-sm grid-cols-2 gap-1">
              {images.map((image, index) => (
                <li key={image.id} className={images.length === 1 ? "col-span-2" : undefined}>
                  <PreviewPhoto
                    image={image}
                    alt={`Imagen adjunta ${index + 1} de ${images.length} en Discord`}
                    className="aspect-[4/3] w-full rounded-md"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </article>
    </PreviewFrame>
  );
}
