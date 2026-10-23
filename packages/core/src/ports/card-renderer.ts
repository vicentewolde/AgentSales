import type { AbortSignalLike } from "../abort.js";
import type { PostImageFormat } from "../post-image.js";

/** El papel de una tarjeta en el carrusel: portada, un punto del texto o el cierre. */
export const CARD_ROLES = ["cover", "point", "closing"] as const;
export type CardRole = (typeof CARD_ROLES)[number];

/**
 * Una tarjeta ya decidida por core (`postCardDeck`): todo su texto sale del post o de la marca,
 * nunca se inventa.
 */
export type CardSpec = {
  role: CardRole;
  /** Portada: el tema; punto: el punto del texto; cierre: el nombre de la marca. */
  text: string;
  /** Cierre: el contacto de la marca (`@cuenta` o su sitio), si tiene. */
  detail: string | null;
  /** Posición (desde 1) y total del carrusel, para «2/6». */
  position: number;
  total: number;
};

/** La marca en las tarjetas: colores `#RRGGBB` y el logo (PNG, como se guarda), si hay. */
export type CardBrand = {
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  logo: Uint8Array | null;
};

/** Una tarjeta dibujada: JPEG del tamaño de su proporción, con el sha256 de sus bytes. */
export type RenderedCard = {
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: "image/jpeg";
  sha256: string;
};

/**
 * Dibuja las tarjetas de la marca (F9.5-T25, ADR-0038 §1.1) con sharp
 * (`@agentsales/media/cards`). Un logo que no se puede leer se omite (se muestra el nombre).
 */
export interface CardRenderer {
  /** Versión del dibujo: cambiarla cambia los bytes (y el sha256) de las tarjetas. */
  readonly version: string;
  render(
    card: CardSpec,
    options: { format: PostImageFormat; brand: CardBrand },
    signal?: AbortSignalLike,
  ): Promise<RenderedCard>;
}
