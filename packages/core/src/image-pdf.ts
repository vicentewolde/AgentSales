// Un PDF con una imagen JPEG por página (spec F9.7 B7, ADR-0043 punto 7): LinkedIn muestra un PDF
// como carrusel (varias imágenes sueltas quedan en cuadrícula recortada). Escrito a mano, sin
// dependencias: cada página tiene el tamaño de su imagen (1 px = 1 punto) y la imagen va tal cual
// (`DCTDecode`), sin volver a comprimir.

/** El ancho y el alto de un JPEG (su marcador SOF); `null` si no es un JPEG legible. */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number; components: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    // SOF0 a SOF15, salvo DHT (C4), JPG (C8) y DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0);
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0);
      const components = bytes[at + 9] ?? 3;
      return width > 0 && height > 0 ? { width, height, components } : null;
    }
    at += 2 + length;
  }
  return null;
}

/** Un texto a bytes Latin-1 (lo de un PDF es ASCII; un carácter fuera de Latin-1 queda «?»). */
function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    out[index] = code > 0xff ? 0x3f : code;
  }
  return out;
}

/**
 * Arma el PDF: catálogo, páginas y, por página, la imagen y su contenido (`q W 0 0 H 0 0 cm /Im0 Do
 * Q`). Lanza si alguna imagen no es un JPEG (quien llama elige solo JPEG).
 */
export function buildImagePdf(jpegs: readonly Uint8Array[], title = "Carrusel"): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? latin1(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: (string | Uint8Array)[]) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    for (const piece of body) push(piece);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%âãÏÓ\n");
  const count = jpegs.length;
  // 1 catálogo, 2 páginas, 3 info; por página: página, imagen y contenido.
  const pageId = (index: number) => 4 + index * 3;
  object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  object(2, [
    `<< /Type /Pages /Count ${count} /Kids [${jpegs.map((_, index) => `${pageId(index)} 0 R`).join(" ")}] >>`,
  ]);
  const safeTitle = title.replace(/[()\\]/gu, "").slice(0, 100);
  object(3, [`<< /Title (${safeTitle}) /Producer (AgentSales) >>`]);
  jpegs.forEach((jpeg, index) => {
    const size = jpegSize(jpeg);
    if (size === null) throw new Error("No es un JPEG");
    const page = pageId(index);
    const content = `q ${size.width} 0 0 ${size.height} 0 0 cm /Im0 Do Q`;
    object(page, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`,
    ]);
    object(page + 1, [
      `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace /${size.components === 1 ? "DeviceGray" : size.components === 4 ? "DeviceCMYK" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      "\nendstream",
    ]);
    object(page + 2, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
  });
  const total = 4 + count * 3;
  const xref = length;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) {
    push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
