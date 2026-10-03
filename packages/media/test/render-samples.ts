// Imágenes de muestra de las plantillas con datos inventados (spec F2-T09): para revisar el diseño.
//   pnpm --filter @agentsales/media run render:samples            →  tmp/render-samples/ (fuera de git)
//   pnpm --filter @agentsales/media run render:samples -- --out docs/assets/plantillas
// (`--out` es relativa a la raíz del repo). Las de `docs/assets/plantillas/` se regeneran cada vez
// que sube `TEMPLATES_VERSION`.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SLIDE_SIZES } from "@agentsales/core";
import { createSlideTemplates } from "@agentsales/templates";
import sharp from "sharp";
import { createHtmlRenderer } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const outFlag = process.argv.indexOf("--out");
const outDir = resolve(
  root,
  outFlag === -1 ? "tmp/render-samples" : (process.argv[outFlag + 1] ?? "tmp/render-samples"),
);
await mkdir(outDir, { recursive: true });

// Una "foto" sintética: cielo, muro y piso, sin personas ni datos de clientes.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb8de"/><stop offset="1" stop-color="#dfe9f3"/></linearGradient></defs>
<rect width="1080" height="1350" fill="url(#sky)"/><rect y="520" width="1080" height="560" fill="#d9cbb5"/>
<rect x="120" y="640" width="300" height="360" fill="#9fb7c9"/><rect x="620" y="640" width="320" height="360" fill="#9fb7c9"/>
<rect y="1080" width="1080" height="270" fill="#8a7158"/></svg>`;
const photo = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
const logo = await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" rx="16" fill="#ffffff"/><text x="160" y="76" font-family="sans-serif" font-size="44" font-weight="700" text-anchor="middle" fill="#1F4E79">INVENTADA</text></svg>`,
  ),
)
  .png()
  .toBuffer();

const brand = {
  brandName: "Inventada Propiedades",
  primaryColor: "#1F4E79",
  secondaryColor: "#F2A900",
  logo: { bytes: new Uint8Array(logo), mime: "image/png" as const, sha256: "logo" },
};
const templates = createSlideTemplates();
const renderer = createHtmlRenderer();

try {
  const cover = templates.cover({
    operation: "sale",
    propertyType: "Departamento",
    comuna: "Ñuñoa",
    price: "UF 5.800",
    facts: [
      { icon: "area", text: "72,5 m²" },
      { icon: "bed", text: "3 dorm" },
      { icon: "bath", text: "2 baños" },
    ],
    photo: { bytes: new Uint8Array(photo), mime: "image/jpeg", sha256: "foto" },
    brand,
  });
  const sheet = templates.specSheet({
    operation: "sale",
    propertyType: "Departamento",
    comuna: "Ñuñoa",
    price: "UF 5.800",
    commonExpenses: "$120.000",
    rows: [
      { icon: "area", label: "Superficie útil", value: "72,5 m²" },
      { icon: "area", label: "Superficie total", value: "80 m²" },
      { icon: "bed", label: "Dormitorios", value: "3" },
      { icon: "bath", label: "Baños", value: "2" },
      { icon: "parking", label: "Estacionamientos", value: "1" },
      { icon: "storage", label: "Bodegas", value: "1" },
      { icon: "compass", label: "Orientación", value: "Norte" },
      { icon: "furniture", label: "Amoblado", value: "No" },
    ],
    availability: "Inmediata",
    contact: { whatsapp: "+56 9 1111 2222", instagramHandle: "inventada.propiedades" },
    brand,
  });
  const overlay = templates.reelOverlay({
    operation: "rent",
    propertyType: "Casa",
    comuna: "Ñuñoa",
    price: "$650.000/mes",
  });

  const files: [string, string, { width: number; height: number }, "jpeg" | "png"][] = [
    ["portada.jpg", cover, SLIDE_SIZES.cover, "jpeg"],
    ["ficha.jpg", sheet, SLIDE_SIZES.specSheet, "jpeg"],
    ["texto-reel.png", overlay, SLIDE_SIZES.reelOverlay, "png"],
  ];
  for (const [name, html, size, format] of files) {
    const { bytes } = await renderer.render(html, { ...size, format });
    await writeFile(join(outDir, name), bytes);
    console.log(`${join(outDir, name)} (${Math.round(bytes.length / 1024)} KB)`);
  }
} finally {
  await renderer.close();
}
