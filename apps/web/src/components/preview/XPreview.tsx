import { Avatar, PhotoGrid, PreviewFrame, PreviewVideoBox } from "./parts.js";
import type { PreviewImage, PreviewVideo } from "./preview.js";

/**
 * Un post de X: la cuenta, el texto entero (X no lo corta: lo limita a 280 con su conteo, que dice
 * el contador) y hasta 4 imágenes en grilla o un video.
 */
export function XPreview({
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
    <PreviewFrame label={label} network="X" draft={draft}>
      <article className="flex max-w-lg gap-3 rounded-lg border border-line bg-surface p-3">
        <Avatar name={accountName} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-1 text-sm">
            <span className="font-bold text-fg">{accountName.replace(/^@/u, "")}</span>
            {accountName.startsWith("@") && <span className="text-fg-subtle">{accountName}</span>}
            <span className="text-fg-subtle">· ahora</span>
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-5 text-fg">
            {text}
          </p>
          {video !== null ? (
            <PreviewVideoBox
              video={video}
              label="Video del post en X"
              className="mt-2 aspect-video w-full rounded-2xl"
            />
          ) : (
            <PhotoGrid
              images={images}
              alt={(index, total) => `Imagen ${index + 1} de ${total} del post en X`}
              className="mt-2 rounded-2xl border border-line"
            />
          )}
          <div
            aria-hidden="true"
            className="mt-3 flex max-w-xs justify-between text-xs text-fg-subtle"
          >
            <span>💬 0</span>
            <span>🔁 0</span>
            <span>♡ 0</span>
            <span>📊 0</span>
          </div>
        </div>
      </article>
    </PreviewFrame>
  );
}
