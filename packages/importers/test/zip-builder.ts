import { crc32, deflateRawSync } from "node:zlib";

/** Una entrada del zip sintético. */
export type ZipEntrySpec = {
  /** Nombre tal cual se escribe, sin validar: así se arman entradas con `..` o absolutas. */
  name: string;
  data?: Uint8Array | string;
  /** Modo Unix (tipo + permisos) para `externalFileAttributes`; por defecto, archivo 0644. */
  mode?: number;
  /** `deflate` permite declarar un tamaño descomprimido falso (`declaredSize`). */
  method?: "store" | "deflate";
  declaredSize?: number;
  /**
   * Marca la entrada como cifrada (bit 0 de las banderas) y antepone los 12 bytes del encabezado
   * del cifrado tradicional, sin cifrar nada: es la forma que yauzl acepta como entrada cifrada.
   */
  encrypted?: boolean;
};

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;
const UTF8_NAMES = 0x0800;
const DOS_DATE_1980 = 0x21;

const u16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
};

/**
 * Arma un zip mínimo en memoria (sin zip64, sin descriptores de datos). Solo para tests: escribe
 * lo que se le pida, incluidos nombres hostiles que ninguna herramienta normal genera.
 */
export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const isDir = entry.name.endsWith("/");
    const deflate = entry.method === "deflate";
    const compressed = deflate ? deflateRawSync(data) : data;
    const body = entry.encrypted ? Buffer.concat([Buffer.alloc(12), compressed]) : compressed;
    const size = entry.declaredSize ?? data.length;
    const flags = UTF8_NAMES | (entry.encrypted ? 1 : 0);
    const mode = entry.mode ?? (isDir ? DIR_MODE : FILE_MODE);
    const shared = Buffer.concat([
      u16(20), // versión necesaria
      u16(flags),
      u16(deflate ? 8 : 0),
      u16(0), // hora
      u16(DOS_DATE_1980),
      u32(crc32(data)),
      u32(body.length),
      u32(size),
      u16(name.length),
    ]);

    const local = Buffer.concat([u32(0x04034b50), shared, u16(0), name, body]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 20), // hecho en Unix: los 16 bits altos de los atributos son el modo
        shared,
        u16(0), // extra
        u16(0), // comentario
        u16(0), // disco
        u16(0), // atributos internos
        u32(mode << 16),
        u32(offset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}
