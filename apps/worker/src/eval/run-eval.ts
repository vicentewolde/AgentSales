import { join } from "node:path";
import {
  type AbortSignalLike,
  type BrokerRepository,
  type EvaluatedText,
  type EvaluateListingContentDeps,
  evaluateListingContent,
  instagramCaption,
  isAppError,
  type ListingEvaluation,
  type ListingRepository,
  PLATFORM_TEXT,
} from "@agentsales/core";

export type EvalDeps = Omit<EvaluateListingContentDeps, "brokers" | "listings"> & {
  brokers: Pick<BrokerRepository, "findBySlug" | "findById">;
  listings: Pick<ListingRepository, "list" | "get">;
  /** Carpeta de esta evaluación (`tmp/eval/<fecha>`, fuera de git). */
  outDir: string;
  writeFile: (path: string, text: string) => Promise<void>;
  print: (line: string) => void;
  printError: (line: string) => void;
};

/** El corredor de las muestras de prueba (spec F2-T16). */
export const DEFAULT_EVAL_BROKER = "agentsales-pruebas";

/** La carpeta de una evaluación, con la hora local y los milisegundos (dos seguidas no chocan). */
export function evalFolderName(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-` +
    pad(date.getMilliseconds(), 3)
  );
}

/**
 * Nombres de archivo seguros para los `id_propiedad` (vienen del Excel): solo letras, números,
 * `.`, `-` y `_`, sin empezar con punto (nada de `..`), y únicos (`A/1` y `A_1` no se pisan).
 */
export function fileNamer(): (externalRef: string) => string {
  const used = new Set<string>();
  return (externalRef) => {
    const base = externalRef.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_") || "_";
    let name = `${base}.md`;
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}.md`;
    used.add(name);
    return name;
  };
}

function checkLines(item: EvaluatedText): string[] {
  if (item.checks.length === 0) return ["sin problemas"];
  return item.checks.map(
    (check) => `${check.severity === "error" ? "✗" : "⚠"} ${check.code}: ${check.message}`,
  );
}

/** Los textos de un aviso, para leerlos en `tmp/eval/` (Markdown). */
export function renderEvaluation(evaluation: ListingEvaluation): string {
  const lines = [
    `# ${evaluation.externalRef}`,
    "",
    `Prompt ${evaluation.promptVersion} · modelo ${evaluation.model} · ${evaluation.attempts} intento(s)`,
  ];
  if (evaluation.warnings.length > 0) {
    lines.push("", "Advertencias de la IA:", ...evaluation.warnings.map((w) => `- ${w}`));
  }
  for (const item of evaluation.texts) {
    lines.push("", `## ${PLATFORM_TEXT[item.platform]}`, "");
    if (item.text.title !== null) lines.push(`**${item.text.title}**`, "");
    lines.push(item.platform === "instagram" ? instagramCaption(item.text) : item.text.body);
    lines.push("", "Revisión:", ...checkLines(item).map((line) => `- ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `pnpm eval:content` (spec F2-T16): evalúa los avisos `ready` de un corredor con el proveedor de IA
 * dado, sin escribir en la base. Imprime la revisión por aviso y canal, deja los textos en
 * `outDir` y devuelve 1 si algún texto tiene errores o algún aviso no se pudo evaluar.
 */
export async function runEval(
  deps: EvalDeps,
  { brokerSlug, signal }: { brokerSlug: string; signal?: AbortSignalLike },
) {
  const broker = await deps.brokers.findBySlug(brokerSlug);
  if (broker === null) {
    deps.printError(`✗ No existe el corredor ${brokerSlug}: indica otro con --broker <slug>`);
    return 1;
  }
  const listings = (await deps.listings.list({ status: "ready" }))
    .filter((listing) => listing.brokerId === broker.id)
    .sort((a, b) => a.externalRef.localeCompare(b.externalRef, "es", { numeric: true }));
  if (listings.length === 0) {
    deps.printError(`✗ ${brokerSlug} no tiene propiedades listas para evaluar`);
    return 1;
  }

  let failed = 0;
  let withErrors = 0;
  let evaluated = 0;
  const fileNameOf = fileNamer();
  for (const listing of listings) {
    // Con Ctrl+C no se pide nada más (cada llamada a la IA gasta cuota del plan).
    if (signal?.aborted) break;
    try {
      const evaluation = await evaluateListingContent(deps, {
        listingId: listing.id,
        ...(signal === undefined ? {} : { signal }),
      });
      evaluated += 1;
      const path = join(deps.outDir, fileNameOf(listing.externalRef));
      await deps.writeFile(path, renderEvaluation(evaluation));
      if (evaluation.hasErrors) withErrors += 1;
      deps.print(`${evaluation.hasErrors ? "✗" : "✓"} ${listing.externalRef}`);
      for (const item of evaluation.texts) {
        const [first, ...rest] = checkLines(item);
        deps.print(`  ${PLATFORM_TEXT[item.platform]}: ${first}`);
        for (const line of rest) deps.print(`    ${line}`);
      }
      for (const warning of evaluation.warnings) deps.print(`  ⚠ IA: ${warning}`);
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (signal?.aborted) break;
      failed += 1;
      deps.print(`✗ ${listing.externalRef}: ${error.code}: ${error.message}`);
    }
  }

  deps.print("");
  if (signal?.aborted) deps.print("Evaluación cortada: no se pidió nada más a la IA.");
  deps.print(
    `Evaluadas ${evaluated} de ${listings.length} · con errores ${withErrors}` +
      (failed > 0 ? ` · no se pudieron evaluar ${failed}` : ""),
  );
  if (evaluated > 0) deps.print(`Textos en ${deps.outDir}`);
  return withErrors > 0 || failed > 0 || evaluated < listings.length ? 1 : 0;
}
