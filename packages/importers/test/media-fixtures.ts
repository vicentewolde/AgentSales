import { createHash } from "node:crypto";

/**
 * Bytes sintéticos con la firma de cada tipo seguida de relleno. No son imágenes ni videos
 * válidos: el lector solo mira la firma y calcula el hash.
 */
const withSignature = (signature: readonly number[] | string, fill: string, length = 64) => {
  const head =
    typeof signature === "string" ? Buffer.from(signature, "latin1") : Buffer.from(signature);
  const body = Buffer.alloc(Math.max(0, length - head.length), fill);
  return new Uint8Array(Buffer.concat([head, body]));
};

const box = (type: string, brand: string) => `\0\0\0\x18${type}${brand}`;

export const SAMPLES = {
  jpeg: (fill = "j", length?: number) => withSignature([0xff, 0xd8, 0xff, 0xe0], fill, length),
  png: (fill = "p", length?: number) =>
    withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], fill, length),
  webp: (fill = "w", length?: number) => withSignature("RIFF\0\0\0\0WEBPVP8 ", fill, length),
  heic: (fill = "h", length?: number) => withSignature(box("ftyp", "heic"), fill, length),
  mp4: (fill = "m", length?: number) => withSignature(box("ftyp", "isom"), fill, length),
  mov: (fill = "q", length?: number) => withSignature(box("ftyp", "qt  "), fill, length),
  movLegacy: (fill = "q", length?: number) => withSignature(box("moov", "mvhd"), fill, length),
};

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
