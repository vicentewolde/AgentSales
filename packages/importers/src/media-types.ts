import type { MediaKind } from "@agentsales/core";

/** Bytes iniciales que bastan para reconocer cualquiera de los tipos aceptados. */
export const SIGNATURE_BYTES = 16;

type MediaType = {
  kind: MediaKind;
  mime: string;
  /** Si los primeros bytes corresponden al tipo. */
  matches(head: Uint8Array): boolean;
};

const ascii = (head: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...head.subarray(offset, offset + length));

const startsWith = (head: Uint8Array, bytes: readonly number[]) =>
  head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);

/** Marcas de HEIF (HEIC del iPhone y variantes). Comparten la caja `ftyp` con mp4 y mov. */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** Marca principal de un archivo ISO BMFF (`....ftypXXXX`), o `null` si no lo es. */
function ftypBrand(head: Uint8Array): string | null {
  return head.length >= 12 && ascii(head, 4, 4) === "ftyp" ? ascii(head, 8, 4) : null;
}

/** Átomos con que empieza un .mov antiguo, sin caja `ftyp`. */
const QUICKTIME_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

const isVideoFtyp = (head: Uint8Array) => {
  const brand = ftypBrand(head);
  return brand !== null && !HEIF_BRANDS.has(brand);
};

const JPEG: MediaType = {
  kind: "image",
  mime: "image/jpeg",
  matches: (head) => startsWith(head, [0xff, 0xd8, 0xff]),
};

/** Tipos aceptados por extensión, en minúsculas (spec F1 §4.3). */
const MEDIA_TYPES: Readonly<Record<string, MediaType>> = {
  jpg: JPEG,
  jpeg: JPEG,
  png: {
    kind: "image",
    mime: "image/png",
    matches: (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  webp: {
    kind: "image",
    mime: "image/webp",
    matches: (head) =>
      head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP",
  },
  heic: {
    kind: "image",
    mime: "image/heic",
    matches: (head) => HEIF_BRANDS.has(ftypBrand(head) ?? ""),
  },
  mp4: { kind: "video", mime: "video/mp4", matches: isVideoFtyp },
  mov: {
    kind: "video",
    mime: "video/quicktime",
    matches: (head) =>
      isVideoFtyp(head) || (head.length >= 8 && QUICKTIME_ATOMS.has(ascii(head, 4, 4))),
  },
};

/** Tipo aceptado según la extensión del nombre (sin mayúsculas), o `null`. */
export function mediaTypeOf(fileName: string): MediaType | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, extension) ? (MEDIA_TYPES[extension] ?? null) : null;
}
