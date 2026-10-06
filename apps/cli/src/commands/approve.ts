import {
  type ContentView,
  contentApproveResponseSchema,
  contentUnapproveResponseSchema,
  listingContentResponseSchema,
} from "@agentsales/api/contracts";
import {
  PLATFORM_SHORT_NAMES,
  PLATFORM_TEXT,
  type PlatformShortName,
  PUBLICATION_FORMAT_TEXT,
} from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { fetchBrokers, resolveListingId } from "./shared.js";

export type ApproveDeps = Io & { client: ApiClient };

export type ApproveOptions = { broker?: string; platform?: string; undo?: boolean };

const SHORT_NAMES = Object.keys(PLATFORM_SHORT_NAMES);
const isShortName = (name: string): name is PlatformShortName =>
  Object.hasOwn(PLATFORM_SHORT_NAMES, name);

const hasErrors = (content: ContentView) =>
  content.checks.some((check) => check.severity === "error");

const formats = (publications: readonly { format: keyof typeof PUBLICATION_FORMAT_TEXT }[]) =>
  publications.map((publication) => PUBLICATION_FORMAT_TEXT[publication.format]).join(" y ");

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
  };
  const hint = error.code === undefined ? undefined : hints[error.code];
  return hint === undefined ? message : `${message} → ${hint}`;
}

/**
 * `agentsales approve <propiedad> [--platform] [--undo]` (spec F3 §4.2 y §4.9): aprueba el texto
 * vigente de cada canal y abre sus publicaciones (Instagram: carrusel y reel) si hay una cuenta
 * conectada. Sin `--platform`, aprueba los canales con texto sin errores y avisa de los demás. Con
 * `--undo`, quita la aprobación y descarta lo que no salió. Informa cada canal y sale con 1 si
 * alguno no se pudo.
 */
export function runApprove(deps: ApproveDeps, ref: string, options: ApproveOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const trimmed = ref.trim();
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
      // Sin --platform se eligen solos: los aprobables (sin errores) o, con --undo, los aprobados.
      if (platform === undefined && !options.undo && hasErrors(content)) {
        failed += 1;
        deps.printError(
          `${c.red("✗")} ${name}: tiene errores en la revisión → corrígelos (agentsales content ${trimmed}) o edítalo en el panel`,
        );
        continue;
      }
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
                ? c.dim(" · sin cuenta conectada: se publica al conectarla")
                : "";
          deps.print(`${c.green("✓")} ${name}: aprobado${opened}`);
          for (const skipped of result.skipped) {
            deps.printError(
              c.yellow(
                `  El ${PUBLICATION_FORMAT_TEXT[skipped.format]} ya tiene una publicación activa de un texto anterior (${skipped.publicationId}): retírala o descártala para publicar este`,
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
      deps.print(c.dim(`→ Publica con: agentsales publish ${trimmed}`));
    }
    return failed > 0 ? 1 : 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("approve")
    .description("Aprueba los textos de una propiedad (o quita la aprobación con --undo)")
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--platform <canal>", `solo un canal: ${SHORT_NAMES.join(", ")}`)
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--undo", "quita la aprobación y descarta las publicaciones que no salieron")
    .action((ref: string, options: ApproveOptions) =>
      exitWith(() => runApprove({ ...ctx, client: ctx.api() }, ref, options)),
    );
}
