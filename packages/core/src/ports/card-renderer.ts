import type { AbortSignalLike } from "../abort.js";
import type { CardComposition, CardStyle } from "../card-style.js";
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
  /**
   * El contacto de la marca (`@cuenta` o su sitio), si tiene: va en el pie de cada tarjeta y, en el
   * cierre, destacado.
   */
  detail: string | null;
  /** Posición (desde 1) y total del carrusel, para «2/6». */
  position: number;
  total: number;
  /**
   * F9.7 B5: el subtítulo de la lámina (lo escribe la IA con los textos, o el operador). Solo lo
   * dibujan las láminas con estilo; sin él, `undefined` o `null`.
   */
  subtitle?: string | null;
  /**
   * F9.7 B6: en la portada de «Explicar», las tarjetas de la grilla (los puntos: etiqueta y
   * título). Solo las láminas con estilo.
   */
  items?: { label: string; text: string }[];
};

/** El estilo de la marca para las láminas (F9.7 B6): su manual, el tema del post y la composición. */
export type CardBrandStyle = {
  style: CardStyle;
  /** El índice del tema en `style.themes` (fijo por post). */
  theme: number;
  composition: CardComposition;
};

/** La marca en las tarjetas: colores `#RRGGBB` y el logo (PNG, como se guarda), si hay. */
export type CardBrand = {
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  logo: Uint8Array | null;
  /** F9.7 B6: con estilo, las láminas se dibujan con él; sin él (o `null`), como antes. */
  style?: CardBrandStyle | null;
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
 * (`createCardRenderer` de `@agentsales/media`). Un logo que no se puede leer se omite (se muestra el nombre).
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
