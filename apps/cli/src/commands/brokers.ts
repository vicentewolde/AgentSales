import { brokerResponseSchema } from "@agentsales/api/contracts";
import type { Command } from "commander";
import { type ApiClient, createHealthFetcher, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { brokerSlugOf, fetchBrokers } from "./shared.js";

// F6-T11 (spec F6 §4.10): activar o apagar `auto_publish` de un corredor.

export type BrokersDeps = Io & Pick<Terminal, "confirm"> & { client: ApiClient };
export type AutoPublishOptions = { yes?: boolean };

/**
 * `agentsales brokers auto-publish <slug> on|off [--yes]`: pregunta siempre (en vivo, en rojo:
 * publicará sin tu revisión); `--yes` no pregunta.
 */
export function runAutoPublish(
  deps: BrokersDeps,
  slugOption: string,
  value: string,
  options: AutoPublishOptions = {},
) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const on = value.trim().toLowerCase();
    if (on !== "on" && on !== "off") {
      throw new CliError("AUTO_PUBLISH_INVALID", `Usa on u off: "${value}"`);
    }
    const slug = brokerSlugOf(slugOption);
    const broker = [...(await fetchBrokers(deps.client)).values()].find((b) => b.slug === slug);
    if (broker === undefined) {
      throw new CliError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`);
    }
    const { publishMode } = await createHealthFetcher(deps.client)();
    if (on === "on" && publishMode === "live") {
      deps.printError(c.bold(c.bgRed(c.white(" La API está EN VIVO: publicará sin tu revisión "))));
    }
    if (!options.yes) {
      const question =
        on === "on"
          ? `¿Activar auto_publish de ${slug}? Al preparar los textos, se aprueban y publican solos (Marketplace queda como recordatorio)`
          : `¿Apagar auto_publish de ${slug}?`;
      if (!(await deps.confirm(question))) {
        deps.printError(c.yellow("No se cambió nada: confirma en la terminal o usa --yes"));
        return 1;
      }
    }
    const { broker: updated } = await unwrap(
      deps.client.brokers[":id"].$patch({
        param: { id: broker.id },
        json: { autoPublish: on === "on" },
      }),
      brokerResponseSchema,
    );
    deps.print(
      `${c.green("✓")} auto_publish de ${updated.slug}: ${updated.autoPublish ? "activado" : "apagado"}`,
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const brokers = program.command("brokers").description("Corredores");
  brokers
    .command("auto-publish")
    .description(
      "Activa (on) o apaga (off) la publicación automática de un corredor: al preparar los textos se aprueba y publica sin tu revisión",
    )
    .argument("<slug>", "corredor")
    .argument("<on|off>", "on u off")
    .option("--yes", "no pide confirmación")
    .action((slug: string, value: string, options: AutoPublishOptions) =>
      exitWith(() => runAutoPublish({ ...ctx, client: ctx.api() }, slug, value, options)),
    );
}
