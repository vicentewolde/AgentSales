import { type ReactNode, useState } from "react";
import { cx } from "../ui/styles.js";
import type { PreviewImage, PreviewVideo } from "./preview.js";

// Las piezas de las vistas previas por red (F9.5-T07, D5): imitan la forma de cada red (la foto,
// el nombre de la cuenta, el texto cortado donde la red lo corta) sin logos ni marcas de las redes.

/**
 * El marco de una vista previa: una figura con nombre (`label`) y la leyenda que dice si se ve el
 * texto guardado o el borrador del editor, todavía sin guardar.
 */
export function PreviewFrame({
  label,
  network,
  draft = false,
  className,
  children,
}: {
  label: string;
  network: string;
  draft?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure aria-label={label} className={cx("min-w-0", className)}>
      <figcaption className="mb-1.5 text-xs font-medium text-fg-subtle">
        Vista previa · {network}
        {draft && <span className="text-warning-800"> · con tu borrador, sin guardar</span>}
      </figcaption>
      {children}
    </figure>
  );
}

/** El círculo con la inicial de la cuenta (no hay foto de perfil). */
export function Avatar({ name, className }: { name: string; className?: string }) {
  const initial = Array.from(name.replace(/^[@#]/, "").trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex size-8 flex-none items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700",
        className,
      )}
    >
      {initial}
    </span>
  );
}

/**
 * Un texto cortado donde lo corta la red (`short`, de `cutText`; `null` si cabe entero), con el
 * botón que lo despliega (`more`, «más» o «ver más») pegado al final, como en la red. `lead` va
 * antes del texto (el nombre de la cuenta en Instagram) y `separator` entre los puntos suspensivos y
 * el botón. El botón dice si el texto está desplegado (`aria-expanded`) y, para el lector de
 * pantalla, qué despliega (`subject`: «el caption», «el texto de la publicación»).
 */
export function MoreText({
  text,
  short,
  more,
  subject,
  separator = " ",
  lead,
  className,
}: {
  text: string;
  short: string | null;
  more: string;
  subject: string;
  separator?: string;
  lead?: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = short !== null && !expanded;
  return (
    <p className={cx("whitespace-pre-line break-words", className)}>
      {lead}
      {collapsed ? short : text}
      {short !== null && (
        <>
          {collapsed ? separator : " "}
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={
              collapsed ? `${more}: mostrar ${subject} completo` : `ver menos: acortar ${subject}`
            }
            onClick={() => setExpanded((value) => !value)}
            className="font-medium text-fg-subtle hover:text-fg hover:underline"
          >
            {collapsed ? more : "ver menos"}
          </button>
        </>
      )}
    </p>
  );
}

/**
 * Una foto, o un recuadro gris si todavía no tiene imagen. Si le falta la versión que publica la
 * red (`processing`), su miniatura atenuada con «procesando…».
 */
export function PreviewPhoto({
  image,
  alt,
  className,
}: {
  image: PreviewImage;
  alt: string;
  className?: string;
}) {
  if (image.processing === true) {
    return (
      <span
        role="img"
        aria-label={`${alt}, procesando…`}
        className={cx("relative block overflow-hidden bg-slate-100", className)}
      >
        {image.src !== null && (
          <img src={image.src} alt="" className="size-full object-cover opacity-40" />
        )}
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center text-xs font-medium text-fg-muted"
        >
          procesando…
        </span>
      </span>
    );
  }
  if (image.src === null) {
    return (
      <span
        role="img"
        aria-label={alt}
        className={cx(
          "flex items-center justify-center bg-slate-100 text-xs text-fg-subtle",
          className,
        )}
      >
        foto
      </span>
    );
  }
  return (
    <img
      src={image.src}
      alt={alt}
      loading="lazy"
      className={cx("bg-slate-100 object-cover", className)}
    />
  );
}

/**
 * Un video: el reproductor si hay de dónde (`src`), o su miniatura con el ▶ (el video original de
 * un post no se carga en la vista previa).
 */
export function PreviewVideoBox({
  video,
  label,
  className,
  children,
}: {
  video: PreviewVideo;
  label: string;
  className?: string;
  /** Lo que va encima del video (el nombre de la cuenta en un reel o en TikTok). */
  children?: ReactNode;
}) {
  return (
    <div className={cx("relative overflow-hidden bg-slate-900", className)}>
      {video.src !== null ? (
        // biome-ignore lint/a11y/useMediaCaption: el texto del video va dibujado en él.
        <video
          src={video.src}
          controls
          preload="metadata"
          aria-label={label}
          className="size-full object-cover"
        />
      ) : (
        <span
          role="img"
          aria-label={video.processing === true ? `${label}, procesando…` : label}
          className="block size-full"
        >
          {video.poster !== null && (
            <img
              src={video.poster}
              alt=""
              className={cx(
                "size-full object-cover",
                video.processing === true ? "opacity-40" : "opacity-90",
              )}
            />
          )}
          <span
            aria-hidden="true"
            className={cx(
              "absolute inset-0 flex items-center justify-center text-white/90",
              video.processing === true ? "text-sm font-medium" : "text-3xl",
            )}
          >
            {video.processing === true ? "procesando…" : "▶"}
          </span>
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * La galería de un aviso (Portal y Marketplace): la primera foto grande (la portada) y las demás en
 * miniatura debajo, todas en 4:3.
 */
export function Gallery({
  photos,
  alt,
}: {
  photos: readonly PreviewImage[];
  alt: (index: number, total: number) => string;
}) {
  const [first, ...rest] = photos;
  if (first === undefined) {
    return (
      <p className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-sm text-fg-subtle">
        Sin fotos todavía.
      </p>
    );
  }
  return (
    <div>
      <PreviewPhoto image={first} alt={alt(0, photos.length)} className="aspect-[4/3] w-full" />
      {rest.length > 0 && (
        <ul className="mt-1 flex gap-1 overflow-x-auto">
          {rest.map((photo, index) => (
            <li key={photo.id} className="w-20 flex-none">
              <PreviewPhoto
                image={photo}
                alt={alt(index + 1, photos.length)}
                className="aspect-[4/3] w-full rounded-sm"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Las fotos en grilla, como X, LinkedIn y Discord muestran varias: una entera; dos lado a lado;
 * tres con la primera alta; cuatro o más en 2×2 y, si hay más de cuatro, «+N» en la última.
 */
export function PhotoGrid({
  images,
  alt,
  className,
}: {
  images: readonly PreviewImage[];
  alt: (index: number, total: number) => string;
  className?: string;
}) {
  if (images.length === 0) return null;
  const shown = images.slice(0, 4);
  const hidden = images.length - shown.length;
  const single = shown.length === 1;
  return (
    <ul
      className={cx(
        "grid gap-0.5 overflow-hidden",
        single ? "grid-cols-1" : "aspect-[16/9] grid-cols-2",
        shown.length > 2 && "grid-rows-2",
        className,
      )}
    >
      {shown.map((image, index) => (
        <li
          key={image.id}
          className={cx("relative min-h-0", shown.length === 3 && index === 0 && "row-span-2")}
        >
          <PreviewPhoto
            image={image}
            alt={alt(index, images.length)}
            className={single ? "aspect-[4/3] w-full" : "size-full"}
          />
          {hidden > 0 && index === shown.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white"
            >
              +{hidden}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
