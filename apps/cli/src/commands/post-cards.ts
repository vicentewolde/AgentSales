import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type PostCardTextsResponse, postCardTextsResponseSchema } from "@agentsales/api/contracts";
import { LANGUAGE_TEXT, LANGUAGES, type Language } from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";

// F9.7 B5 y B7 (ADR-0043): `agentsales post cards-text <id>` (ver y editar los textos de las
// láminas) y `agentsales post pdf <id>` (las láminas de un idioma en un PDF para LinkedIn).

export type PostCardsDeps = Io & { client: ApiClient; cwd: string };

function languageOf(text: string | undefined): Language | undefined {
  if (text === undefined) return undefined;
  const found = LANGUAGES.find((language) => language === text.trim().toLowerCase());
  if (found === undefined)
    throw new CliError("OPTION_INVALID", `--language es ${LANGUAGES.join(" o ")}`);
  return found;
}

function printTexts(deps: Io, view: PostCardTextsResponse, only: Language | undefined): void {
  const c = deps.colors;
  for (const language of view.languages.filter((item) => only === undefined || item === only)) {
    const texts = view.texts.filter((text) => text.language === language);
    deps.print(c.bold(`Láminas en ${LANGUAGE_TEXT[language]}`));
    if (texts.length === 0) deps.print(c.dim("  (sin textos: se redactan con los del post)"));
    for (const text of texts) {
      const label = text.role === "cover" ? "Portada" : `Punto ${text.position - 1}`;
      deps.print(
        `  ${label}: ${text.headline}${text.subtitle === "" ? "" : ` — ${text.subtitle}`}`,
      );
      for (const check of text.checks) {
        deps.print(
          `    ${check.severity === "error" ? c.red("✗") : c.yellow("!")} ${check.message}`,
        );
      }
    }
  }
}

export type CardsTextOptions = { language?: string; file?: string; json?: boolean };

/**
 * `agentsales post cards-text <id> [--language es] [--file láminas.json]`: sin `--file`, las muestra;
 * con `--file` (una lista `[{ "headline": "…", "subtitle": "…" }]`, la primera es la portada),
 * reemplaza las de ese idioma (y ya no las pisa una redacción nueva).
 */
export function runCardsText(deps: PostCardsDeps, id: string, options: CardsTextOptions) {
  return guarded(deps, async () => {
    const language = languageOf(options.language);
    let view: PostCardTextsResponse;
    if (options.file !== undefined) {
      if (language === undefined) {
        throw new CliError("OPTION_REQUIRED", "Con --file, di el idioma con --language es|en");
      }
      let texts: unknown;
      try {
        texts = JSON.parse(await readFile(resolve(deps.cwd, options.file), "utf8"));
      } catch {
        throw new CliError("FILE_INVALID", `${options.file} no se pudo leer como JSON`);
      }
      if (!Array.isArray(texts)) {
        throw new CliError("FILE_INVALID", `${options.file} debe ser una lista de láminas`);
      }
      view = await unwrap(
        deps.client.posts[":id"]["card-texts"][":language"].$put({
          param: { id, language },
          json: { texts: texts as { headline: string; subtitle?: string }[] },
        }),
        postCardTextsResponseSchema,
      );
      deps.print(`${deps.colors.green("✓")} Láminas guardadas`);
    } else {
      view = await unwrap(
        deps.client.posts[":id"]["card-texts"].$get({ param: { id } }),
        postCardTextsResponseSchema,
      );
    }
    if (options.json) deps.print(JSON.stringify(view, null, 2));
    else printTexts(deps, view, language);
    return 0;
  });
}

/** `agentsales post pdf <id> [--language es] [--out carrusel.pdf]`: el PDF para LinkedIn. */
export function runPostPdf(
  deps: PostCardsDeps,
  id: string,
  options: { language?: string; out?: string },
) {
  return guarded(deps, async () => {
    const language = languageOf(options.language) ?? "es";
    const response = await deps.client.posts[":id"]["linkedin-pdf"].$get({
      param: { id },
      query: { language },
    });
    if (!response.ok) await unwrap(response, postCardTextsResponseSchema);
    const out = resolve(deps.cwd, options.out ?? `carrusel-${id.slice(0, 8)}-${language}.pdf`);
    await writeFile(out, new Uint8Array(await response.arrayBuffer()));
    const pages = response.headers.get("x-agentsales-pages") ?? "?";
    deps.print(`${deps.colors.green("✓")} PDF para LinkedIn (${pages} páginas): ${out}`);
    const skipped = Number(response.headers.get("x-agentsales-skipped") ?? "0");
    if (skipped > 0) {
      deps.print(deps.colors.yellow(`${skipped} imágenes no son JPEG y no van en el PDF`));
    }
    return 0;
  });
}

export function registerPostCards(post: Command, ctx: CliContext): void {
  const deps = (): PostCardsDeps => ({ ...ctx, client: ctx.api() });
  post
    .command("cards-text <id>")
    .description(
      "Ve o edita los textos de las láminas de un post (titular y subtítulo de cada una)",
    )
    .option("--language <es|en>", "el idioma (con --file, obligatorio)")
    .option(
      "--file <láminas.json>",
      'reemplaza las de ese idioma: [{"headline": "…", "subtitle": "…"}]',
    )
    .option("--json", "salida en JSON")
    .action((id: string, options: CardsTextOptions) =>
      exitWith(() => runCardsText(deps(), id, options)),
    );
  post
    .command("pdf <id>")
    .description("Baja las láminas de un idioma en un PDF para LinkedIn (se ve como carrusel)")
    .option("--language <es|en>", "el idioma (por defecto es)")
    .option("--out <archivo.pdf>", "dónde guardarlo")
    .action((id: string, options: { language?: string; out?: string }) =>
      exitWith(() => runPostPdf(deps(), id, options)),
    );
}
