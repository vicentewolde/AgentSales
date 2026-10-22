import { Gallery, PreviewFrame } from "./parts.js";
import type { PreviewImage } from "./preview.js";

/**
 * Un aviso de Portal Inmobiliario: las fotos (la portada primero), el título, el precio como en la
 * planilla (`UF 5.800`, `$650.000/mes`) y la descripción entera.
 */
export function PortalPreview({
  label,
  title,
  price,
  photos,
  description,
  draft = false,
}: {
  label: string;
  title: string | null;
  price: string | null;
  photos: readonly PreviewImage[];
  description: string | null;
  draft?: boolean;
}) {
  return (
    <PreviewFrame label={label} network="Portal Inmobiliario" draft={draft}>
      <article className="max-w-xl overflow-hidden rounded-lg border border-line bg-surface">
        <Gallery
          photos={photos}
          alt={(index, total) => `Foto ${index + 1} de ${total} para Portal Inmobiliario`}
        />
        <div className="p-4">
          {title !== null && <h3 className="text-lg font-semibold text-fg">{title}</h3>}
          {price !== null && <p className="mt-1 text-2xl font-semibold text-fg">{price}</p>}
          {description !== null && (
            <>
              <p className="mt-4 text-sm font-semibold text-fg">Descripción</p>
              <p className="mt-1 whitespace-pre-line break-words text-sm text-fg">{description}</p>
            </>
          )}
        </div>
      </article>
    </PreviewFrame>
  );
}
