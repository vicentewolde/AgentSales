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
            {[
              "M4 5h16v11H9l-5 4z",
              "M4 8h12l-3-3M20 16H8l3 3",
              "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 5.6-7 10-7 10z",
              "M5 20V10M12 20V4M19 20v-7",
            ].map((d) => (
              <span key={d} className="inline-flex items-center gap-1">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={d} />
                </svg>
                0
              </span>
            ))}
          </div>
        </div>
      </article>
    </PreviewFrame>
  );
}
