import type { AbortSignalLike } from "../abort.js";
import type { Operation } from "../enums.js";

/**
 * Una imagen que usa una plantilla (la foto de portada o el logo): la plantilla arma el `data:`
 * con los bytes, y la clave del render usa el `sha256` (spec F2 §4.2), no los bytes.
 */
export type SlideImage = { bytes: Uint8Array; mime: "image/jpeg" | "image/png"; sha256: string };

/** Íconos de las plantillas (SVG propios en `packages/templates`). */
export const SLIDE_ICONS = [
  "area",
  "bed",
  "bath",
  "parking",
  "storage",
  "floor",
  "calendar",
  "compass",
  "pet",
  "furniture",
  "money",
  "info",
] as const;
export type SlideIcon = (typeof SLIDE_ICONS)[number];

/** Un dato con su ícono, ya formateado por core (`72,5 m²`, `3 dorm`). */
export type SlideFact = { icon: SlideIcon; text: string };

/** La marca del corredor en las plantillas: colores `#RRGGBB` y el logo (PNG o JPG), si hay. */
export type SlideBrand = {
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  logo: SlideImage | null;
};

/**
 * Portada del carrusel (spec F2 §4.2): la foto a sangre, la etiqueta `VENTA` o `ARRIENDO`, el
 * precio, `Tipo · Comuna` y los datos que existan (hasta 3: m² útiles, dormitorios y baños). Nunca
 * lleva la dirección: el tipo no tiene dónde ponerla.
 */
export type CoverData = {
  operation: Operation;
  propertyType: string;
  comuna: string | null;
  /** `UF 5.800` o `$650.000/mes`. */
  price: string;
  facts: SlideFact[];
  /** La variante `ig_4x5` de la foto de portada (JPEG), así una portada HEIC funciona. */
  photo: SlideImage;
  brand: SlideBrand;
};

/** Ficha del carrusel: tabla de atributos con íconos, disponibilidad y contacto. */
export type SpecSheetData = {
  operation: Operation;
  propertyType: string;
  comuna: string | null;
  price: string;
  /** `$120.000`, o `null` si no hay. */
  commonExpenses: string | null;
  rows: { icon: SlideIcon; label: string; value: string }[];
  availability: string | null;
  contact: { whatsapp: string | null; instagramHandle: string | null };
  brand: SlideBrand;
};

/** Texto de los primeros 2 s del reel: `Venta · Departamento · Ñuñoa · UF 5.800`. */
export type ReelOverlayData = {
  operation: Operation;
  propertyType: string;
  comuna: string | null;
  price: string;
};

/**
 * Plantillas de las imágenes del carrusel y del reel (spec F2 §4.2): arman HTML autocontenido (la
 * tipografía y las imágenes van como `data:`; nada de red), con los datos escapados. `version`
 * entra en la clave de R2 de los renders y del reel: cambiar el diseño la sube y los rehace.
 */
export interface SlideTemplates {
  readonly version: string;
  /** 1080×1350. */
  cover(data: CoverData): string;
  /** 1080×1350. */
  specSheet(data: SpecSheetData): string;
  /** 1080×1920, fondo transparente. */
  reelOverlay(data: ReelOverlayData): string;
}

/** Tamaños de cada plantilla, para el renderizador. */
export const SLIDE_SIZES = {
  cover: { width: 1080, height: 1350 },
  specSheet: { width: 1080, height: 1350 },
  reelOverlay: { width: 1080, height: 1920 },
} as const;

/** Un render: los bytes y su sha256 (la clave de R2 y `media.checksum`). */
export type RenderedImage = { bytes: Uint8Array; sha256: string };

/**
 * Convierte HTML en imagen (spec F2 §4.2; Playwright en `packages/media`). Cada render bloquea toda
 * la red (solo `data:`). Errores (`AppError`):
 * - `RENDER_BROWSER_NOT_INSTALLED`: falta Chromium (no reintentable, con el comando para instalarlo);
 * - `RENDER_TIMEOUT` (reintentable): pasó el tope de 30 s;
 * - `RENDER_ABORTED` (reintentable): se cortó con `signal`;
 * - `RENDER_FAILED`: el navegador no pudo dibujar la página.
 */
export interface HtmlRenderer {
  render(
    html: string,
    options: { width: number; height: number; format: "jpeg" | "png" },
    signal?: AbortSignalLike,
  ): Promise<RenderedImage>;
}
