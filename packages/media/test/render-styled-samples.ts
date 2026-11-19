import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CARD_COMPOSITIONS,
  type CardSpec,
  type PostImageFormat,
  parseCardStyle,
} from "@agentsales/core";
import { renderStyledCard } from "../src/styled-cards.js";

// Muestras de las láminas con estilo (F9.7 B6): el estilo de AgentPey (`docs/marca/agentpey/
// estilo.json`) con textos de ejemplo, en cada tema, composición y proporción. Uso:
// `pnpm --filter @agentsales/media run render:styled [carpeta] [--all-formats]`. Solo para mirar.

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(process.argv[2] ?? join(root, "tmp/laminas-f97"));
const allFormats = process.argv.includes("--all-formats");
const style = parseCardStyle(
  JSON.parse(await readFile(join(root, "docs/marca/agentpey/estilo.json"), "utf8")),
);
const brand = {
  brandName: "AgentPey",
  primaryColor: "#176bff",
  secondaryColor: "#6df2c0",
  logo: null,
};
const detail = "@agentpeyai";
const cover: CardSpec = {
  role: "cover",
  text: "Ganamos los Stellar Instawards.",
  subtitle: "Gracias, Stellar, por el apoyo. Seguimos construyendo.",
  detail,
  position: 1,
  total: 4,
  items: [
    { label: "Pagos", text: "Tu agente de IA compra online y paga en USDC sobre Stellar." },
    { label: "Límites", text: "Límites de gasto que hace cumplir un contrato." },
    { label: "Recibos", text: "Un recibo firmado por cada compra." },
    { label: "Funciona con", text: "Claude y ChatGPT, por MCP." },
  ],
};
// El titular de tres líneas de AgentPey, con y sin subtítulo (la que se mira en las redes).
const ias: CardSpec = {
  role: "cover",
  text: "Las IAs casi no recomiendan tiendas pequeñas",
  subtitle: "En 116 respuestas, 5 tiendas chilenas aparecieron solo en 19 (16%). Es una muestra.",
  detail,
  position: 1,
  total: 1,
  items: cover.items ?? [],
};
const iasNoSubtitle: CardSpec = { ...ias, subtitle: null };
const point: CardSpec = {
  role: "point",
  text: "Límites que no se negocian",
  subtitle: "Un contrato en Stellar hace cumplir cuánto puede gastar tu agente, compra por compra.",
  detail,
  position: 2,
  total: 4,
};
const closing: CardSpec = { role: "closing", text: "AgentPey", detail, position: 4, total: 4 };
await mkdir(out, { recursive: true });
const formats: PostImageFormat[] = allFormats ? ["4:5", "1:1", "9:16"] : ["4:5"];
for (const format of formats) {
  for (const composition of CARD_COMPOSITIONS) {
    for (let theme = 0; theme < style.themes.length; theme++) {
      const named: [string, CardSpec][] = [
        ["cover", cover],
        ["point", point],
        ["closing", closing],
        ["ias-con", ias],
        ["ias-sin", iasNoSubtitle],
      ];
      for (const [label, card] of named) {
        const result = await renderStyledCard(card, brand, { style, theme, composition }, format);
        const name = `${format.replace(":", "x")}-${composition}-tema${theme + 1}-${label}.png`;
        await writeFile(join(out, name), result.png);
        if (!result.fits) console.log(`no cabe: ${name}`);
      }
    }
  }
}
console.log(`Muestras en ${out}`);
