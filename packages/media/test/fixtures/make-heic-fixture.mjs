// Genera la foto HEIC sintética de los tests (spec F2-T07): sin personas ni datos de clientes.
// Se corrió una sola vez en macOS; el resultado está versionado en esta carpeta.
//
//   node test/fixtures/make-heic-fixture.mjs /tmp/sintetica.jpg
//   sips -s format heic /tmp/sintetica.jpg --out test/fixtures/sintetica-1600x1200-orientacion-6.heic
//
// Un JPEG de 1600×1200 (degradado con un bloque rojo arriba a la izquierda) con EXIF Orientation
// = 6. `sips` lo codifica en mosaicos HEVC (grupo `Tile Grid` de 12 piezas, verificado con
// `ffprobe -show_stream_groups`) y guarda el giro como `irot`: derecho, mide 1200×1600 y el bloque
// rojo queda arriba a la derecha.
import sharp from "sharp";

const [out] = process.argv.slice(2);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#335"/><stop offset="1" stop-color="#9ab"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect x="0" y="0" width="400" height="300" fill="#e00"/></svg>`;
await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toFile(out);
