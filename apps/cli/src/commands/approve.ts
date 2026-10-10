import {
  contentApproveResponseSchema,
  contentUnapproveResponseSchema,
  listingContentResponseSchema,
} from "@agentsales/api/contracts";
import {
  PLATFORM_TEXT,
  type Platform,
  type PublicationFormat,
  publicationFormatText,
} from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { readinessIssueLine } from "./publication-view.js";
import {
  fetchBrokers,
  manualConfirmHint,
  PLATFORM_OPTION_NAMES,
  platformOption,
  platformShortName,
  resolveListingId,
} from "./shared.js";

export type ApproveDeps = Io & { client: ApiClient };

export type ApproveOptions = { broker?: string; platform?: string; undo?: boolean };

const formats = (publications: readonly { platform: Platform; format: PublicationFormat }[]) =>
  publications
    .map((publication) => publicationFormatText(publication.platform, publication.format))
    .join(" y ");

/** Un rechazo de la API para un canal, con qué hacer, sin cortar los demás. */
function reasonOf(error: unknown, ref: string): string {
  if (!(error instanceof ApiCallError) || error.status === undefined) throw error;
  const message = `${error.code ?? "ERROR"}: ${error.apiMessage ?? error.message}`;
  const hints: Record<string, string> = {
    CONTENT_HAS_ERRORS: `corrige los errores (agentsales content ${ref}) o edítalo en el panel`,
    CONTENT_NOT_READY: `faltan las fotos del canal: prepáralas con agentsales prepare ${ref}`,
    CONTENT_RUN_ACTIVE: "espera a que termine la preparación en curso",
    CONTENT_NOT_CURRENT: "el texto cambió: vuelve a intentarlo",
    PUBLICATION_IN_PROGRESS: "espera a que termine la publicación en curso",
    LISTING_NOT_READY: `revisa la propiedad con agentsales listing ${ref}`,
    MANUAL_CONFIRM_PENDING: manualConfirmHint(error.publicationId),
  };
  const hint = error.code === undefined ? undefined : hints[error.code];
  return hint === undefined ? message : `${message} → ${hint}`;
}

/**
 * `agentsales approve <propiedad> [--platform] [--undo]` (spec F3 §4.2 y §4.9): aprueba el texto
 * vigente de cada canal y abre sus publicaciones (Instagram: carrusel y reel) si hay una cuenta
 * conectada. Sin `--platform`, intenta todos los canales con texto: los que tienen errores en la
 * revisión los rechaza la API (`CONTENT_HAS_ERRORS`) y se informan con qué hacer. Con
 * `--undo`, quita la aprobación y descarta lo que no salió. Informa cada canal y sale con 1 si
 * alguno no se pudo.
 */
export function runApprove(deps: ApproveDeps, ref: string, options: ApproveOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const trimmed = ref.trim();
    const platform: Platform | undefined =
      options.platform === undefined ? undefined : platformOption(options.platform);
    const brokers = await fetchBrokers(deps.client);
    const listingId = await resolveListingId(deps.client, trimmed, brokers, options.broker);
    const { contents } = await unwrap(
      deps.client.listings[":id"].content.$get({ param: { id: listingId } }),
      listingContentResponseSchema,
    );
    const channel =
      platform === undefined ? contents : contents.filter((item) => item.platform === platform);
    if (channel.length === 0) {
      throw new CliError(
        "CONTENT_NOT_FOUND",
        platform === undefined
          ? `${trimmed} todavía no tiene textos`
          : `${trimmed} no tiene texto de ${PLATFORM_TEXT[platform]}`,
        `Prepáralos con agentsales prepare ${trimmed}`,
      );
    }

    let failed = 0;
    let done = 0;
    for (const content of channel) {
      const name = PLATFORM_TEXT[content.platform];
      // Sin --platform, con --undo, solo los aprobados. Los errores de la revisión los decide la API
      // (`CONTENT_HAS_ERRORS`), y se informan con qué hacer, sin cortar los demás canales.
      if (platform === undefined && options.undo && content.status !== "approved") continue;
      try {
        if (options.undo) {
          const result = await unwrap(
            deps.client.contents[":id"].unapprove.$post({ param: { id: content.id } }),
            contentUnapproveResponseSchema,
          );
          const cancelled =
            result.cancelled.length > 0 ? ` · descartadas: ${formats(result.cancelled)}` : "";
          deps.print(`${c.green("✓")} ${name}: aprobación quitada${cancelled}`);
        } else {
          const result = await unwrap(
            deps.client.contents[":id"].approve.$post({ param: { id: content.id } }),
            contentApproveResponseSchema,
          );
          const opened =
            result.created.length > 0
              ? ` · listas para publicar: ${formats(result.created)}`
              : result.publications.length === 0
                ? c.dim(" · sin cuenta conectada: conéctala y publica con agentsales publish")
                : "";
          deps.print(`${c.green("✓")} ${name}: aprobado${opened}`);
          // Portal y Marketplace: lo que le falta al aviso (se aprueba igual; publicar lo exige).
          for (const [channel, readiness] of [
            ["Portal", result.portalReadiness],
            ["Marketplace", result.marketplaceReadiness],
          ] as const) {
            const missing = readiness?.issues ?? [];
            if (missing.length === 0) continue;
            deps.printError(c.yellow(`  Para publicar en ${channel} falta:`));
            for (const issue of missing) {
              deps.printError(c.yellow(`  ${readinessIssueLine(issue)}`));
            }
          }
          for (const skipped of result.skipped) {
            deps.printError(
              c.yellow(
                `  El ${publicationFormatText(content.platform, skipped.format)} ya tiene una publicación activa de un texto anterior (${skipped.publicationId}): retírala o descártala para publicar este`,
              ),
            );
          }
        }
        done += 1;
      } catch (error) {
        failed += 1;
        deps.printError(`${c.red("✗")} ${name}: ${reasonOf(error, trimmed)}`);
      }
    }
    if (done === 0 && failed === 0) {
      deps.print(c.yellow(`${trimmed} no tiene textos aprobados`));
      return 0;
    }
    if (done > 0 && !options.undo) {
      // Instagram es el canal por defecto de publish; los demás llevan su --platform.
      const extra =
        platform === undefined || platform === "instagram"
          ? ""
          : ` --platform ${platformShortName(platform)}`;
      deps.print(c.dim(`→ Publica con: agentsales publish ${trimmed}${extra}`));
    }
    return failed > 0 ? 1 : 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("approve")
    .description("Aprueba los textos de una propiedad (o quita la aprobación con --undo)")
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--platform <canal>", `solo un canal: ${PLATFORM_OPTION_NAMES.join(", ")}`)
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--undo", "quita la aprobación y descarta las publicaciones que no salieron")
    .action((ref: string, options: ApproveOptions) =>
      exitWith(() => runApprove({ ...ctx, client: ctx.api() }, ref, options)),
    );
}
