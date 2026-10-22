import { type UIEvent, useState } from "react";
import { captionPreview } from "../content/caption.js";
import { cx } from "../ui/styles.js";
import { Avatar, MoreText, PreviewFrame, PreviewPhoto, PreviewVideoBox } from "./parts.js";
import { cutText, type PreviewImage, type PreviewText, type PreviewVideo } from "./preview.js";

type Caption = Pick<PreviewText, "body" | "hashtags">;

/** La cabecera de un post: la inicial y el nombre de la cuenta. */
function Header({ accountName }: { accountName: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Avatar name={accountName} className="size-7 text-xs" />
      <span className="truncate text-sm font-semibold text-fg">{accountName}</span>
    </div>
  );
}

/**
 * El carrusel: se desliza (también con las flechas, una vez enfocado) y dice en qué imagen va, con
 * el contador arriba y los puntos abajo, como Instagram.
 */
function Carousel({ images }: { images: readonly PreviewImage[] }) {
  const [page, setPage] = useState(0);
  const onScroll = (event: UIEvent<HTMLUListElement>) => {
    const { scrollLeft, clientWidth } = event.currentTarget;
    if (clientWidth > 0) setPage(Math.round(scrollLeft / clientWidth));
  };
  return (
    <div>
      <div className="relative">
        <ul
          aria-label="Carrusel de Instagram"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: una lista que se desplaza debe poder enfocarse.
          tabIndex={0}
          onScroll={onScroll}
          className="flex snap-x snap-mandatory overflow-x-auto"
        >
          {images.map((image, index) => (
            <li key={image.id} className="w-full flex-none snap-start">
              <PreviewPhoto
                image={image}
                alt={`Imagen ${index + 1} de ${images.length} del carrusel`}
                className="aspect-[4/5] w-full"
              />
            </li>
          ))}
        </ul>
        <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white tabular-nums">
          {page + 1}/{images.length}
          <span className="sr-only"> imágenes</span>
        </span>
      </div>
      <div aria-hidden="true" className="flex justify-center gap-1 pt-2">
        {images.map((image, index) => (
          <span
            key={image.id}
            className={cx(
              "size-1.5 rounded-full",
              index === page ? "bg-brand-600" : "bg-slate-300",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Un post de Instagram (imagen o carrusel): la cuenta, la imagen o el carrusel con su indicador, y
 * el caption con los hashtags cortado como Instagram, con «… más».
 */
export function InstagramPostPreview({
  label,
  accountName,
  images,
  text,
  draft = false,
  noMedia = "Sin imágenes todavía.",
}: {
  label: string;
  accountName: string;
  images: readonly PreviewImage[];
  text: Caption | null;
  draft?: boolean;
  /** Lo que se dice sin imágenes (un post de Instagram las necesita). */
  noMedia?: string;
}) {
  const caption = text === null ? null : captionPreview(text);
  const [single] = images;
  return (
    <PreviewFrame label={label} network="Instagram" draft={draft}>
      <article className="max-w-sm overflow-hidden rounded-lg border border-line bg-surface">
        <Header accountName={accountName} />
        {images.length === 0 || single === undefined ? (
          <p className="flex aspect-[4/5] items-center justify-center bg-slate-100 p-4 text-center text-sm text-fg-subtle">
            {noMedia}
          </p>
        ) : images.length === 1 ? (
          <PreviewPhoto image={single} alt="Imagen del post" className="aspect-[4/5] w-full" />
        ) : (
          <Carousel images={images} />
        )}
        {caption !== null && (
          <section aria-label="Caption de Instagram" className="px-3 pt-2 pb-3 text-sm text-fg">
            <MoreText
              text={caption.full}
              short={caption.preview}
              more="más"
              lead={<strong className="font-semibold">{accountName} </strong>}
            />
          </section>
        )}
      </article>
    </PreviewFrame>
  );
}

/**
 * Un reel (o un video en Instagram): vertical, con la cuenta y el comienzo del caption encima del
 * video, como Instagram.
 */
export function InstagramReelPreview({
  label,
  accountName,
  video,
  text,
  draft = false,
}: {
  label: string;
  accountName: string;
  video: PreviewVideo;
  text: Caption | null;
  draft?: boolean;
}) {
  const caption = text === null ? null : captionPreview(text).full;
  return (
    <PreviewFrame label={label} network="Instagram, reel" draft={draft}>
      <PreviewVideoBox
        video={video}
        label="Reel de Instagram"
        className="aspect-[9/16] w-52 rounded-lg"
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-12 space-y-1 px-3 text-white drop-shadow">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Avatar name={accountName} className="size-6 text-xs" />
            <span className="truncate">{accountName}</span>
          </p>
          {caption !== null && (
            <p className="text-xs">{cutText(caption, { chars: 60, lines: 1 }) ?? caption}</p>
          )}
        </div>
      </PreviewVideoBox>
    </PreviewFrame>
  );
}
