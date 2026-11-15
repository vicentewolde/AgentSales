import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { CardFont } from "@agentsales/core";

// Las fuentes de las láminas con estilo (spec F9.7 B6, ADR-0043 D4): Inter Tight e Inter de
// `@fontsource` (OFL). Pango (el texto de sharp) no lee los WOFF de fontsource con `fontfile`: aquí
// se convierten una vez a TTF (WOFF 1 es zlib por tabla; se reescribe el encabezado sfnt) en una
// carpeta temporal, y se lee el nombre de la familia de su tabla `name` (fontsource la llama
// «Inter Tight SemiBold» en el 600, por ejemplo). En macOS Pango usa CoreText y no lee `fontfile`
// (ver `cards.ts`): ahí se usa la fuente del sistema con el nombre genérico.

const PACKAGES: Readonly<Record<CardFont, { pkg: string; file: string; family: string }>> = {
  "inter-tight": { pkg: "@fontsource/inter-tight", file: "inter-tight", family: "Inter Tight" },
  inter: { pkg: "@fontsource/inter", file: "inter", family: "Inter" },
};

export const USE_FONT_FILE = process.platform !== "darwin";

/** WOFF 1 → sfnt (TTF u OTF): inflar cada tabla y escribir el directorio de tablas. */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.readUInt32BE(0) !== 0x774f4646) throw new Error("No es un WOFF");
  const flavor = woff.readUInt32BE(4);
  const count = woff.readUInt16BE(12);
  const tables = Array.from({ length: count }, (_, index) => {
    const at = 44 + index * 20;
    return {
      tag: woff.readUInt32BE(at),
      offset: woff.readUInt32BE(at + 4),
      compLength: woff.readUInt32BE(at + 8),
      origLength: woff.readUInt32BE(at + 12),
      checksum: woff.readUInt32BE(at + 16),
    };
  });
  const selector = Math.floor(Math.log2(count));
  const range = 16 * 2 ** selector;
  const header = Buffer.alloc(12 + 16 * count);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(range, 6);
  header.writeUInt16BE(selector, 8);
  header.writeUInt16BE(count * 16 - range, 10);
  let offset = header.length;
  const parts: Buffer[] = [header];
  tables.forEach((table, index) => {
    const raw = woff.subarray(table.offset, table.offset + table.compLength);
    const data = table.compLength < table.origLength ? inflateSync(raw) : raw;
    const at = 12 + index * 16;
    header.writeUInt32BE(table.tag, at);
    header.writeUInt32BE(table.checksum, at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(table.origLength, at + 12);
    const pad = (4 - (data.length % 4)) % 4;
    parts.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
  });
  return Buffer.concat(parts);
}

/** El nombre de la familia (nameID 1, Windows Unicode) de un sfnt. */
export function familyNameOf(sfnt: Buffer): string | null {
  const count = sfnt.readUInt16BE(4);
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    if (sfnt.toString("latin1", at, at + 4) !== "name") continue;
    const table = sfnt.readUInt32BE(at + 8);
    const records = sfnt.readUInt16BE(table + 2);
    const strings = table + sfnt.readUInt16BE(table + 4);
    for (let r = 0; r < records; r++) {
      const rec = table + 6 + r * 12;
      const platform = sfnt.readUInt16BE(rec);
      const nameId = sfnt.readUInt16BE(rec + 6);
      if (platform !== 3 || nameId !== 1) continue;
      const length = sfnt.readUInt16BE(rec + 8);
      const start = strings + sfnt.readUInt16BE(rec + 10);
      const bytes = Buffer.from(sfnt.subarray(start, start + length));
      bytes.swap16();
      return bytes.toString("utf16le");
    }
  }
  return null;
}

export type ResolvedFont = { family: string; file: string | null };

const cache = new Map<string, ResolvedFont>();

/**
 * La fuente lista para Pango: el TTF convertido (en `tmpdir()/agentsales-fonts`, una vez por
 * proceso y archivo) y su familia. Si algo falla, la fuente del sistema con el nombre genérico.
 */
export function resolveFont(font: CardFont, weight: number): ResolvedFont {
  const key = `${font}-${weight}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const meta = PACKAGES[font];
  let resolved: ResolvedFont = { family: meta.family, file: null };
  if (USE_FONT_FILE) {
    try {
      const woffPath = fileURLToPath(
        import.meta.resolve(`${meta.pkg}/files/${meta.file}-latin-${weight}-normal.woff`),
      );
      const sfnt = woffToSfnt(readFileSync(woffPath));
      const dir = join(tmpdir(), "agentsales-fonts");
      mkdirSync(dir, { recursive: true });
      const hash = createHash("sha256").update(sfnt).digest("hex").slice(0, 12);
      const file = join(dir, `${meta.file}-${weight}-${hash}.ttf`);
      writeFileSync(file, sfnt);
      resolved = { family: familyNameOf(sfnt) ?? meta.family, file };
    } catch {
      resolved = { family: meta.family, file: null };
    }
  }
  cache.set(key, resolved);
  return resolved;
}
