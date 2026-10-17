import { usageResponseSchema } from "@agentsales/api/contracts";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io, renderTable } from "../output.js";

// F7-T16 (spec F7 §4.7 y §4.10): el gasto de IA del mes por corredor (el corredor ve el suyo).

export type UsageDeps = Io & { client: ApiClient };
export type UsageOptions = { month?: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `US$ 1,23` (dos decimales y coma). */
const usd = (value: number) => `US$ ${value.toFixed(2).replace(".", ",")}`;

/**
 * `agentsales usage [--month AAAA-MM]`: lo gastado en IA por corredor en el mes de Chile (por
 * defecto el actual), con su tope y las corridas. Es una estimación: manda la consola de Anthropic.
 */
export function runUsage(deps: UsageDeps, options: UsageOptions = {}) {
  return guarded(deps, async () => {
    if (options.month !== undefined && !MONTH.test(options.month)) {
      throw new CliError(
        "MONTH_INVALID",
        `El mes debe ser AAAA-MM (por ejemplo 2026-10): "${options.month}"`,
      );
    }
    const { month, brokers } = await unwrap(
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
    deps.print(
      renderTable(
        ["Corredor", "Gastado", "Tope", "Corridas"],
        brokers.map((row) => {
          const over = row.capUsd !== null && row.spentUsd >= row.capUsd;
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
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("usage")
    .description("El gasto de IA del mes por corredor (estimado), con su tope")
    .option("--month <AAAA-MM>", "el mes (por defecto, el actual en Chile)")
    .action((options: UsageOptions) =>
      exitWith(() => runUsage({ ...ctx, client: ctx.api() }, options)),
    );
}
