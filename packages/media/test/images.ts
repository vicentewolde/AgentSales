import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// libvips usa por defecto un hilo por núcleo: con los demás archivos de tests corriendo en
// paralelo, eso atrasaba tests ajenos hasta su tope de 5 s. En los tests basta con dos.
sharp.concurrency(2);

/** ffmpeg y ffprobe de verdad (la CI instala 8.1 o más nuevo; spec F2, D6). */
export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export const HEIC_FIXTURE = new URL(
  "./fixtures/sintetica-1600x1200-orientacion-6.heic",
  import.meta.url,
);

/**
 * Una foto sintética: un degradado con un bloque rojo en la esquina superior izquierda (un cuarto
 * del ancho y del alto), para ver la orientación. Con `orientation`, la guarda en el EXIF; con
 * `gps`, le pone una ubicación (como las fotos del iPhone).
 */
export async function syntheticPhoto(
  width: number,
  height: number,
  options: { orientation?: number; gps?: boolean; format?: "jpeg" | "png"; p3?: boolean } = {},
): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#335"/><stop offset="1" stop-color="#9ab"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<rect x="0" y="0" width="${width / 4}" height="${height / 4}" fill="#e00"/></svg>`;
  let image = sharp(Buffer.from(svg));
  image = options.format === "png" ? image.png() : image.jpeg({ quality: 90 });
  if (options.orientation !== undefined)
    image = image.withMetadata({ orientation: options.orientation });
  if (options.p3) image = image.withIccProfile("p3");
  if (options.gps) {
    image = image.withExif({
      IFD0: { Make: "Fabricante Inventado", Model: "Modelo Inventado" },
      IFD3: {
        GPSLatitudeRef: "S",
        GPSLatitude: "33/1 27/1 0/1",
        GPSLongitudeRef: "W",
        GPSLongitude: "70/1 36/1 0/1",
      },
    });
  }
  return new Uint8Array(await image.toBuffer());
}

/** El color de un píxel (RGB). */
export async function pixel(bytes: Uint8Array, x: number, y: number): Promise<number[]> {
  const data = await sharp(bytes)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer();
  return [...data].slice(0, 3);
}

export const isRed = ([r = 0, g = 0, b = 0]: number[]) => r > 180 && g < 70 && b < 70;

/**
 * Un ffmpeg falso (script de Node) para los casos que el de verdad no puede dar: una versión vieja
 * o un proceso que no termina. Responde `-version` con `version`; si no, espera 60 s.
 */
export async function fakeFfmpeg(version: string): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agentsales-fake-ffmpeg-"));
  const path = join(dir, "ffmpeg");
  await writeFile(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("-version")) {
  process.stdout.write(${JSON.stringify(`ffmpeg version ${version} Copyright\n`)});
  process.exit(0);
}
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
setTimeout(() => {}, 60000);
`,
  );
  await chmod(path, 0o755);
  return { path, dir };
}
