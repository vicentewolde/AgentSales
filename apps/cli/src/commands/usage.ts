import { usageQuerySchema, usageResponseSchema } from "@agentsales/api/contracts";
import { formatUsd as usd } from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io, renderTable } from "../output.js";

// F7-T16 (spec F7 §4.7 y §4.10): el gasto de IA del mes por corredor (el corredor ve el suyo).

export type UsageDeps = Io & { client: ApiClient };
export type UsageOptions = { month?: string };

/**
 * `agentsales usage [--month AAAA-MM]`: lo gastado en IA por corredor en el mes de Chile (por
 * defecto el actual), con su tope y las corridas. Es una estimación: manda la consola de Anthropic.
 * Desde F9.5-T25, aparte, las imágenes con IA de cada marca que creó alguna (consola de Google).
 */
export function runUsage(deps: UsageDeps, options: UsageOptions = {}) {
  return guarded(deps, async () => {
    // El mismo esquema que la API: un mes mal escrito no llega a llamarla.
    if (!usageQuerySchema.safeParse({ month: options.month }).success) {
      throw new CliError(
        "MONTH_INVALID",
        `El mes debe ser AAAA-MM (por ejemplo 2026-10): "${options.month}"`,
      );
    }
    const { month, brokers, images } = await unwrap(
      deps.client.usage.$get({
        query: options.month === undefined ? {} : { month: options.month },
      }),
      usageResponseSchema,
    );
    deps.print(
      `Gasto de IA de ${month} (estimado: la cifra oficial está en la consola de Anthropic)`,
    );
    if (brokers.length === 0) {
      deps.print("No hay corredores.");
      return 0;
    }
    const c = deps.colors;
    deps.print(c.bold("Textos"));
    deps.print(
      renderTable(
        ["Corredor", "Gastado", "Tope", "Corridas"],
        brokers.map((row) => {
          const over = row.capReached;
          return [
            row.slug,
            over ? c.red(usd(row.spentUsd)) : usd(row.spentUsd),
            row.capUsd === null
              ? "sin tope"
              : usd(row.capUsd) + (over ? c.red(" (alcanzado)") : ""),
            String(row.runs),
          ];
        }),
        c,
      ),
    );
    // F9.5-T25 (ADR-0038 §3): las imágenes con IA, aparte, con el tope del servidor por marca.
    const withImages = images.filter((row) => row.images > 0 || row.spentUsd > 0);
    deps.print("");
    deps.print(
      c.bold("Imágenes con IA") +
        c.dim(" (estimado con IMAGE_AI_PRICE_USD: la cifra oficial está en la consola de Google)"),
    );
    if (withImages.length === 0) {
      deps.print("Nadie creó imágenes con IA este mes.");
      return 0;
    }
    deps.print(
      renderTable(
        ["Corredor", "Gastado", "Tope", "Imágenes"],
        withImages.map((row) => [
          row.slug,
          row.capReached ? c.red(usd(row.spentUsd)) : usd(row.spentUsd),
          usd(row.capUsd) + (row.capReached ? c.red(" (alcanzado)") : ""),
          String(row.images),
        ]),
        c,
      ),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("usage")
    .description(
      "El gasto de IA del mes por corredor (estimado), con su tope; aparte, las imágenes con IA",
    )
    .option("--month <AAAA-MM>", "el mes (por defecto, el actual en Chile)")
    .action((options: UsageOptions) =>
      exitWith(() => runUsage({ ...ctx, client: ctx.api() }, options)),
    );
}
