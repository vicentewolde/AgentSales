import type { PostCover } from "@agentsales/api/contracts";
import { cx } from "../ui/styles.js";

/**
 * La imagen pequeña de un post en las listas (Contenido, Plan): su portada, con «video» o la
 * cantidad si lleva más de una, o un recuadro «sin imagen». Es decorativa: el título del post va al
 * lado y es lo que se lee.
 */
export function PostThumb({
  cover,
  className,
}: {
  cover: PostCover | undefined;
  className?: string;
}) {
  const box =
    "relative block aspect-[4/5] w-20 shrink-0 sm:w-24 overflow-hidden rounded-lg border border-line";
  if (cover === undefined) {
    return (
      <span
        aria-hidden="true"
        className={cx(
          box,
          "flex items-center justify-center bg-canvas p-1 text-center text-[10px] leading-tight text-fg-subtle",
          className,
        )}
      >
        sin imagen
      </span>
    );
  }
  return (
    <span className={cx(box, "bg-canvas", className)}>
      {cover.kind === "video" ? (
        <video
          src={cover.url}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          className="size-full object-cover"
        />
      ) : (
        <img
          src={cover.url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      )}
      {(cover.kind === "video" || cover.count > 1) && (
        <span className="absolute right-1 bottom-1 rounded bg-fg/80 px-1 text-[10px] font-semibold text-surface">
          {cover.kind === "video" ? "video" : `${cover.count} img`}
        </span>
      )}
    </span>
  );
}
