import {
  type ContentRunView,
  contentRunRequestResponseSchema,
  contentRunResponseSchema,
  listingContentResponseSchema,
} from "@agentsales/api/contracts";
import { contentRunProgressText, isTerminalContentRun } from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded } from "../output.js";
import { paintContentRunStatus, renderChecksSummary, renderContentRun } from "./content-view.js";
import { fetchBrokers, resolveListingId } from "./shared.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

export type PrepareOptions = {
  broker?: string;
  /** `--no-texts` lo deja en `false`: solo medios, portada, ficha y reel. */
  texts?: boolean;
  replaceEdits?: boolean;
  /** `--no-wait` lo deja en `false`. */
  wait?: boolean;
};

export type PrepareDeps = WaitDeps & { client: ApiClient };

/** Los 409 de `POST /listings/:id/content-runs`, con qué hacer en la CLI. */
function explained(error: unknown, ref: string): unknown {
  if (!(error instanceof ApiCallError)) return error;
  if (error.code === "CONTENT_EDITED") {
    return new CliError(
      "CONTENT_EDITED",
      `${ref} tiene textos editados a mano o aprobados: preparar de nuevo los reemplazaría`,
      `Usa --no-texts para rehacer solo las imágenes, o --replace-edits para reemplazar los textos`,
    );
  }
  if (error.code === "PUBLICATION_PENDING") {
    return new CliError(
      "PUBLICATION_PENDING",
      `${ref} tiene publicaciones aprobadas que no han salido: preparar de nuevo cambiaría lo aprobado`,
      "Publícalas o descártalas antes de preparar de nuevo",
    );
  }
  if (error.code === "LISTING_NOT_READY") {
    return new CliError(
      "LISTING_NOT_READY",
      error.apiMessage ?? error.message,
      `Revisa la propiedad con agentsales listing ${ref}`,
    );
  }
  return error;
}

/**
 * `agentsales prepare <propiedad>` (spec F2 §4.7): pide la preparación del contenido y la espera
 * como `import` (`RUN_WAIT`), mostrando la etapa. Al final, el resumen de la corrida y la revisión
 * editorial de los textos vigentes. Sale con 1 si la corrida falló.
 */
export function runPrepare(deps: PrepareDeps, ref: string, options: PrepareOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const trimmed = ref.trim();
    const brokers = await fetchBrokers(deps.client);
    const listingId = await resolveListingId(deps.client, trimmed, brokers, options.broker);
    const texts = options.texts ?? true;
    const { contentRun, reused } = await unwrap(
      deps.client.listings[":id"]["content-runs"].$post({
        param: { id: listingId },
        json: { texts, replaceEdits: options.replaceEdits ?? false },
      }),
      contentRunRequestResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, trimmed);
    });

    if (reused) {
      // A stderr: con `--no-wait`, la única línea de stdout es el id.
      deps.printError(
        c.yellow(
          `Ya había una preparación de ${trimmed} en curso: sigo esa` +
            (contentRun.texts === texts
              ? ""
              : contentRun.texts
                ? " (esa sí redacta los textos)"
                : " (esa no redacta los textos)"),
        ),
      );
    }
    if (options.wait === false) {
      deps.print(contentRun.id);
      deps.printError(c.dim(`→ Revisa el resultado con: agentsales content ${trimmed}`));
      return 0;
    }

    deps.print(`Preparación ${contentRun.id} (${trimmed}): ${contentRunProgressText(contentRun)}…`);
    const done = await waitForRun<ContentRunView>(deps, {
      run: contentRun,
      fetch: async () =>
        (
          await unwrap(
            deps.client["content-runs"][":id"].$get({ param: { id: contentRun.id } }),
            contentRunResponseSchema,
          )
        ).contentRun,
      isTerminal: (run) => isTerminalContentRun(run.status),
      progress: contentRunProgressText,
      laterCommand: `agentsales content ${trimmed}`,
      noun: "la preparación",
    });
    if (done === null) return 1;

    deps.print("");
    deps.print(renderContentRun(done, c));
    if (done.status === "succeeded" && done.texts) {
      // La preparación ya terminó: si la revisión no se puede leer, se avisa sin fallar.
      try {
        const { contents } = await unwrap(
          deps.client.listings[":id"].content.$get({ param: { id: listingId } }),
          listingContentResponseSchema,
        );
        deps.print("");
        deps.print(renderChecksSummary(contents, c));
      } catch {
        deps.printError(
          c.yellow("No se pudo leer la revisión editorial: mírala con agentsales content"),
        );
      }
    }
    if (done.status === "succeeded") {
      deps.print("");
      deps.print(c.dim(`→ Mira los textos con: agentsales content ${trimmed}`));
    } else {
      deps.printError(c.red(`✗ La preparación ${paintContentRunStatus(done, c)}`));
    }
    return done.status === "succeeded" ? 0 : 1;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("prepare")
    .description("Prepara el contenido de una propiedad (fotos, portada, reel y textos) y espera")
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--no-texts", "rehace solo las imágenes y el reel, sin tocar los textos")
    .option("--replace-edits", "reemplaza también los textos editados a mano o aprobados")
    .option("--no-wait", "imprime el id de la preparación y sale sin esperar")
    .action((ref: string, options: PrepareOptions) =>
      exitWith(() =>
        runPrepare(
          {
            ...ctx,
            client: ctx.api(),
            sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
            now: () => performance.now(),
          },
          ref,
          options,
        ),
      ),
    );
}
