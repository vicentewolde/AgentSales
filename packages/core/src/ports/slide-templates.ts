import type { AbortSignalLike } from "../abort.js";
import type { Operation } from "../enums.js";

/** Formatos que una plantilla puede incrustar (Chromium los dibuja). Un logo HEIC no va. */
export const SLIDE_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SlideImageMime = (typeof SLIDE_IMAGE_MIMES)[number];

/**
 * Una imagen sin sus bytes: lo que entra en la clave de R2 de un render (spec F2 §4.2). Sale de
 * `media` (`mime` y `checksum`) sin descargar nada.
 */
export type SlideImageRef = { mime: SlideImageMime; sha256: string };

/**
 * Una imagen que usa una plantilla (la foto de portada o el logo): la plantilla arma el `data:`
 * con los bytes, y la clave del render usa el `sha256` (`slideKeyInput`), no los bytes.
 */
export type SlideImage = SlideImageRef & { bytes: Uint8Array };

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

/**
 * La marca del corredor en las plantillas: colores `#RRGGBB` y el logo (JPEG, PNG o WebP), si hay.
 * Un logo en otro formato (HEIC) va como `null` y se muestra el nombre de la marca.
 */
export type SlideBrand<Image extends SlideImageRef = SlideImage> = {
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  logo: Image | null;
};

/**
 * Portada del carrusel (spec F2 §4.2): la foto a sangre, la etiqueta `VENTA` o `ARRIENDO`, el
 * precio, `Tipo · Comuna` y los datos que existan (hasta 3: m² útiles, dormitorios y baños). Nunca
 * lleva la dirección: el tipo no tiene dónde ponerla.
 */
export type CoverData<Image extends SlideImageRef = SlideImage> = {
  operation: Operation;
  propertyType: string;
  comuna: string | null;
  /** `UF 5.800` o `$650.000/mes`. */
  price: string;
  facts: SlideFact[];
  /** La variante `ig_4x5` de la foto de portada (JPEG), así una portada HEIC funciona. */
  photo: Image;
  brand: SlideBrand<Image>;
};

/** Ficha del carrusel: tabla de atributos con íconos, disponibilidad y contacto. */
export type SpecSheetData<Image extends SlideImageRef = SlideImage> = {
  operation: Operation;
  propertyType: string;
  comuna: string | null;
  price: string;
  /** `$120.000`, o `null` si no hay. */
  commonExpenses: string | null;
  rows: { icon: SlideIcon; label: string; value: string }[];
  availability: string | null;
  contact: { whatsapp: string | null; instagramHandle: string | null };
  brand: SlideBrand<Image>;
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

const isImage = (value: unknown): value is SlideImageRef =>
  typeof value === "object" &&
  value !== null &&
  "sha256" in value &&
  "mime" in value &&
  typeof (value as SlideImageRef).sha256 === "string";

/**
 * Los datos de una plantilla tal como entran en la clave de R2 del render (spec F2 §4.2): cada
 * imagen queda solo con `mime` y `sha256`, sin bytes. Acepta los datos con o sin bytes, así la
 * corrida (F2-T10) calcula la clave desde `media` y descarga las imágenes solo si cambió. Se pasa a
 * `canonicalJson` junto con la versión de las plantillas.
 */
export function slideKeyInput(
  data: CoverData<SlideImageRef> | SpecSheetData<SlideImageRef> | ReelOverlayData,
): unknown {
  const strip = (value: unknown): unknown => {
    if (isImage(value)) return { mime: value.mime, sha256: value.sha256 };
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, strip(child)]));
    }
    return value;
  };
  return strip(data);
}
