import { listingContentResponseSchema } from "@agentsales/api/contracts";
import { PLATFORM_SHORT_NAMES, type PlatformShortName } from "@agentsales/core";
import { type Command, Option } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { renderContent, renderContentMedia } from "./content-view.js";
import { fetchBrokers, resolveListingId } from "./shared.js";

export type ContentDeps = Io & { client: ApiClient };

export type ContentOptions = { broker?: string; platform?: string; json?: boolean };

const SHORT_NAMES = Object.keys(PLATFORM_SHORT_NAMES);

const isShortName = (name: string): name is PlatformShortName =>
  Object.hasOwn(PLATFORM_SHORT_NAMES, name);

/**
 * `agentsales content <propiedad> [--platform] [--json]` (spec F2 §4.7): los textos vigentes con
 * su revisión editorial, los medios por canal y la última preparación.
 */
export function runContent(deps: ContentDeps, ref: string, options: ContentOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    let platform: (typeof PLATFORM_SHORT_NAMES)[PlatformShortName] | undefined;
    if (options.platform !== undefined) {
      const name = options.platform.trim().toLowerCase();
      if (!isShortName(name)) {
        throw new CliError(
          "PLATFORM_INVALID",
          `--platform debe ser ${SHORT_NAMES.join(", ")}: "${options.platform}"`,
        );
      }
      platform = PLATFORM_SHORT_NAMES[name];
    }
    const trimmed = ref.trim();
    const brokers = await fetchBrokers(deps.client);
    const listingId = await resolveListingId(deps.client, trimmed, brokers, options.broker);
    const content = await unwrap(
      deps.client.listings[":id"].content.$get({ param: { id: listingId } }),
      listingContentResponseSchema,
    );
    const contents =
      platform === undefined
        ? content.contents
        : content.contents.filter((item) => item.platform === platform);

    if (options.json) {
      deps.print(JSON.stringify({ ...content, contents }, null, 2));
      return 0;
    }
    deps.print(c.bold(`Contenido de ${trimmed}`));
    deps.print(renderContentMedia(content, c));
    if (contents.length === 0) {
      deps.print("");
      deps.print(
        c.yellow(
          platform === undefined
            ? "Todavía no tiene textos"
            : "Todavía no tiene textos en ese canal",
        ),
      );
      deps.print(c.dim(`→ Prepáralos con: agentsales prepare ${trimmed}`));
      return 0;
    }
    for (const item of contents) {
      deps.print("");
      deps.print(renderContent(item, c));
    }
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("content")
    .description("Textos de una propiedad por canal, con su revisión editorial")
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .addOption(new Option("--platform <canal>", "solo un canal").choices(SHORT_NAMES))
    .option("--json", "salida en JSON (con las URLs temporales de los medios)")
    .action((ref: string, options: ContentOptions) =>
      exitWith(() => runContent({ ...ctx, client: ctx.api() }, ref, options)),
    );
}
