import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type CardStyleResponse, cardStyleResponseSchema } from "@agentsales/api/contracts";
import {
  CARD_COMPOSITIONS,
  type CardComposition,
  POST_IMAGE_FORMATS,
  type PostImageFormat,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { brandOf } from "./brand.js";

// F9.7 B4 (ADR-0043): `agentsales brand style show|edit|preview`, el estilo de las imágenes de la
// marca (colores, fuentes de la lista, márgenes, logo y hasta 4 temas que se rotan). Se carga desde
// un JSON (para AgentPey, `docs/marca/agentpey/estilo.json`); lo valida la API.

export type StyleDeps = Io & { client: ApiClient; cwd: string };

const COMPOSITION_TEXT: Readonly<Record<CardComposition, string>> = {
  announce: "Anuncio",
  explain: "Explicar",
};

function printStyle(deps: Io, brandName: string, view: CardStyleResponse["cardStyle"]): void {
  const c = deps.colors;
  deps.print(c.bold(`Estilo de imágenes de ${brandName}`));
  if (view.style === null) {
    deps.print(
      c.yellow(
        "Sin estilo: las tarjetas salen con los colores de la marca (brand style edit --file)",
      ),
    );
    return;
  }
  const { style } = view;
  deps.print(
    `Fuentes: titular ${style.fonts.headline.family} ${style.fonts.headline.weight}, texto ${style.fonts.body.family} ${style.fonts.body.weight}`,
  );
  deps.print(
    `Márgenes: ${style.margins.side} px a los lados, ${style.margins.top} arriba, ${style.margins.bottom} abajo`,
  );
  deps.print(`Logo: ${style.logo === null ? "sin logo" : style.logo.kind.toUpperCase()}`);
  deps.print(`Temas (rotan uno por post): ${style.themes.map((theme) => theme.name).join(" · ")}`);
  deps.print(c.dim(`Versión ${view.version ?? 0}`));
  for (const warning of view.warnings) {
    deps.print(
      c.yellow(
        `Contraste bajo en ${warning.theme}: ${warning.what} ${warning.text} sobre ${warning.background}`,
      ),
    );
  }
}

export function runStyleShow(deps: StyleDeps, options: { broker?: string; json?: boolean } = {}) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const { cardStyle } = await unwrap(
      deps.client.brokers[":id"]["card-style"].$get({ param: { id: broker.id } }),
      cardStyleResponseSchema,
    );
    if (options.json) deps.print(JSON.stringify(cardStyle.style, null, 2));
    else printStyle(deps, broker.brandName, cardStyle);
    return 0;
  });
}

/** `agentsales brand style edit --file estilo.json`: reemplaza el estilo (lo valida la API). */
export function runStyleEdit(deps: StyleDeps, options: { broker?: string; file?: string }) {
  return guarded(deps, async () => {
    if (options.file === undefined) {
      throw new CliError(
        "FILE_REQUIRED",
        "Falta el archivo del estilo",
        "Usa --file estilo.json (el de brand style show --json, o docs/marca/agentpey/estilo.json)",
      );
    }
    let style: unknown;
    try {
      style = JSON.parse(await readFile(resolve(deps.cwd, options.file), "utf8"));
    } catch {
      throw new CliError("FILE_INVALID", `${options.file} no se pudo leer como JSON`);
    }
    const broker = await brandOf(deps.client, options.broker);
    const { cardStyle } = await unwrap(
      deps.client.brokers[":id"]["card-style"].$put({ param: { id: broker.id }, json: { style } }),
      cardStyleResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Estilo guardado: las próximas tarjetas lo usan`);
    printStyle(deps, broker.brandName, cardStyle);
    return 0;
  });
}

export type StylePreviewOptions = {
  broker?: string;
  theme?: string;
  composition?: string;
  format?: string;
  out?: string;
};

/** `agentsales brand style preview [--theme 1] [--composition announce|explain] [--format] --out`. */
export function runStylePreview(deps: StyleDeps, options: StylePreviewOptions) {
  return guarded(deps, async () => {
    const theme = options.theme === undefined ? 1 : Number(options.theme);
    if (!Number.isInteger(theme) || theme < 1 || theme > 4) {
      throw new CliError("OPTION_INVALID", "--theme es un número de 1 a 4");
    }
    const composition = (options.composition ?? "announce") as CardComposition;
    if (!CARD_COMPOSITIONS.includes(composition)) {
      throw new CliError("OPTION_INVALID", `--composition es ${CARD_COMPOSITIONS.join(" o ")}`);
    }
    const format = (options.format ?? "4:5") as PostImageFormat;
    if (!POST_IMAGE_FORMATS.includes(format)) {
      throw new CliError("OPTION_INVALID", `--format es ${POST_IMAGE_FORMATS.join(", ")}`);
    }
    const broker = await brandOf(deps.client, options.broker);
    const response = await deps.client.brokers[":id"]["card-style"].preview.$post({
      param: { id: broker.id },
      json: { theme: theme - 1, composition, format },
    });
    // Un error trae su código y mensaje (sin estilo: CARD_STYLE_NOT_FOUND): `unwrap` lo lanza.
    if (!response.ok) await unwrap(response, cardStyleResponseSchema);
    const out = resolve(
      deps.cwd,
      options.out ?? `muestra-${broker.slug}-${composition}-${theme}.png`,
    );
    await writeFile(out, new Uint8Array(await response.arrayBuffer()));
    deps.print(
      `${deps.colors.green("✓")} Muestra «${COMPOSITION_TEXT[composition]}», tema ${theme}, ${format}: ${out}`,
    );
    return 0;
  });
}

export function registerStyle(brand: Command, ctx: CliContext): void {
  const deps = (): StyleDeps => ({ ...ctx, client: ctx.api() });
  const style = brand
    .command("style")
    .description(
      "El estilo de las imágenes de la marca: colores, fuentes, logo y temas que se rotan",
    );
  style
    .command("show")
    .description("Muestra el estilo")
    .option("--broker <slug>", "la marca (si tienes más de una)")
    .option("--json", "el estilo en JSON, para editarlo y cargarlo con --file")
    .action((options: { broker?: string; json?: boolean }) =>
      exitWith(() => runStyleShow(deps(), options)),
    );
  style
    .command("edit")
    .description("Carga el estilo desde un JSON (reemplaza el anterior)")
    .option("--broker <slug>", "la marca (si tienes más de una)")
    .option("--file <estilo.json>", "el estilo (ej. docs/marca/agentpey/estilo.json)")
    .action((options: { broker?: string; file?: string }) =>
      exitWith(() => runStyleEdit(deps(), options)),
    );
  style
    .command("preview")
    .description("Guarda una lámina de muestra con el estilo guardado (PNG)")
    .option("--broker <slug>", "la marca (si tienes más de una)")
    .option("--theme <n>", "el tema, de 1 a 4 (por defecto 1)")
    .option("--composition <announce|explain>", "Anuncio o Explicar (por defecto announce)")
    .option("--format <4:5|1:1|9:16>", "la proporción (por defecto 4:5)")
    .option("--out <archivo.png>", "dónde guardarla")
    .action((options: StylePreviewOptions) => exitWith(() => runStylePreview(deps(), options)));
}
