import { Gallery, PreviewFrame } from "./parts.js";
import type { PreviewImage } from "./preview.js";

/**
 * Un aviso de Facebook Marketplace: las fotos (las mismas de Portal), el título, el precio al mes
 * en pesos y la descripción del vendedor entera. El formulario de Marketplace no tiene campo de
 * título (docs/04): el título se muestra con esa advertencia, porque no se escribe en Facebook.
 */
export function MarketplacePreview({
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
    <PreviewFrame label={label} network="Facebook Marketplace" draft={draft}>
      <article className="max-w-xl overflow-hidden rounded-lg border border-line bg-surface">
        <Gallery
          photos={photos}
          alt={(index, total) => `Foto ${index + 1} de ${total} para Facebook Marketplace`}
        />
        <div className="p-4">
          {title !== null && (
            <>
              <h3 className="text-lg font-semibold text-fg">{title}</h3>
              <p className="text-xs text-fg-subtle">
                El formulario de Marketplace no tiene título: este no se escribe en Facebook (lo usa
                el plan B).
              </p>
            </>
          )}
          {price !== null && <p className="mt-1 text-lg font-semibold text-fg">{price}</p>}
          {description !== null && (
            <>
              <p className="mt-4 text-sm font-semibold text-fg">Descripción del vendedor</p>
              <p className="mt-1 whitespace-pre-line break-words text-sm text-fg">{description}</p>
            </>
          )}
        </div>
      </article>
    </PreviewFrame>
  );
}
