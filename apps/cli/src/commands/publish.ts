import {
  listingPublishResponseSchema,
  type PublicationView,
  publicationResponseSchema,
} from "@agentsales/api/contracts";
import {
  healthReportSchema,
  PLATFORM_TEXT,
  type Platform,
  PUBLICATION_STATUS_TEXT,
  publicationModeText,
} from "@agentsales/core";
import type { Command } from "commander";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded } from "../output.js";
import { formatText, portalIssueLine, renderPublicationResult } from "./publication-view.js";
import { fetchBrokers, platformOption, platformShortName, resolveListingId } from "./shared.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

export type PublishOptions = {
  broker?: string;
  platform?: string;
  /** `--no-wait` lo deja en `false`. */
  wait?: boolean;
  yes?: boolean;
};

export type PublishDeps = WaitDeps & Pick<Terminal, "confirm"> & { client: ApiClient };

/** Cómo se conecta la cuenta de cada canal (`ACCOUNT_NOT_CONNECTED`). */
const CONNECT_HINT: Partial<Record<Platform, string>> = {
  instagram:
    "Conecta la cuenta con agentsales accounts connect instagram --broker <slug> --token-stdin",
  portal_inmobiliario:
    "Conecta la cuenta con agentsales accounts connect mercadolibre --broker <slug>",
};

/**
 * `PORTAL_NOT_READY` (spec F4 §4.11): la lista de lo que falta, un motivo por línea con su columna
 * del Excel. El `message` de la API ya junta los mismos motivos: se muestra uno u otro, nunca los
 * dos. Sin lista (una API de otra versión), el `message`.
 */
function portalNotReady(error: ApiCallError): CliError {
  const issues = error.issues ?? [];
  const message =
    issues.length === 0
      ? (error.apiMessage ?? error.message)
      : [
          "Falta información para publicar en Portal Inmobiliario:",
          ...issues.map(portalIssueLine),
        ].join("\n");
  return new CliError(
    "PORTAL_NOT_READY",
    message,
    "Completa la planilla, vuelve a importarla (agentsales import) y publica de nuevo; el WhatsApp es el de la hoja Corredor",
  );
}

/** Los errores de `POST /listings/:id/publish`, con qué hacer en la CLI. */
function explained(error: unknown, ref: string, platform: Platform): unknown {
  if (!(error instanceof ApiCallError)) return error;
  if (error.code === "PORTAL_NOT_READY") return portalNotReady(error);
  const message = error.apiMessage ?? error.message;
  const hints: Record<string, string> = {
    QUEUE_UNAVAILABLE:
      "Quedaron en curso: arranca el worker (pnpm dev), que las retoma al arrancar, o vuelve a correr agentsales publish",
    CONTENT_NOT_APPROVED: `Aprueba el texto con agentsales approve ${ref} --platform ${platformShortName(platform)}`,
    ...(CONNECT_HINT[platform] === undefined
      ? {}
      : { ACCOUNT_NOT_CONNECTED: CONNECT_HINT[platform] }),
    CONTENT_HAS_ERRORS: `Revisa el texto con agentsales content ${ref}, corrígelo y vuelve a aprobarlo`,
    PUBLICATION_LISTING_CHANGED: `La propiedad cambió desde que se aprobó: vuelve a preparar y aprobar el texto (agentsales prepare ${ref})`,
    NOTHING_TO_PUBLISH: `Mira el estado con agentsales publications ${ref}`,
    PUBLISH_MODE_LOCKED:
      "Ya empezó en vivo y no se reintenta en simulación: descártala con agentsales publications cancel <id>, o reinicia la API en vivo si lo decides tú",
    LISTING_NOT_READY: `Revisa la propiedad con agentsales listing ${ref}`,
    CONTENT_RUN_ACTIVE:
      "Espera a que termine la preparación (agentsales content) y vuelve a publicar",
  };
  const hint = error.code === undefined ? undefined : hints[error.code];
  if (hint === undefined) return error;
  if (error.code === "QUEUE_UNAVAILABLE") {
    return new CliError(
      "QUEUE_UNAVAILABLE",
      "La cola no responde: las publicaciones quedaron en curso, sin job",
      hint,
    );
  }
  return new CliError(error.code ?? "API_ERROR", message, hint);
}

/** Lo que se espera: las publicaciones que quedaron en curso, leídas juntas en cada consulta. */
type PublishWait = { status: string; publications: PublicationView[] };

const inProgress = (publication: PublicationView) => publication.status === "publishing";

/**
 * `agentsales publish <propiedad> [--platform instagram] [--no-wait] [--yes]` (spec F3 §4.9): con la
 * API en vivo pide confirmación (salvo `--yes`), publica el canal y espera el carrusel y el reel a la
 * vez (`GET /publications/:id`) hasta que salgan o fallen, con el enlace o el motivo. Sale con 1 si
 * alguna falló o si deja de esperar.
 */
export function runPublish(deps: PublishDeps, ref: string, options: PublishOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const trimmed = ref.trim();
    const platform = platformOption(options.platform ?? "instagram");
    const brokers = await fetchBrokers(deps.client);
    const listingId = await resolveListingId(deps.client, trimmed, brokers, options.broker);
    // El modo lo decide la API (D11): solo se pregunta para confirmar una publicación en vivo.
    const { publishMode } = await unwrap(deps.client.health.$get(), healthReportSchema);
    if (publishMode === "live" && !options.yes) {
      const confirmed = await deps.confirm(
        `La API está en vivo (PUBLISH_MODE=live): ¿publicar ${trimmed} de verdad en ${PLATFORM_TEXT[platform]}?${platform === "portal_inmobiliario" ? " Usa un cupo de tu paquete de Mercado Libre." : ""}`,
      );
      if (!confirmed) {
        deps.printError(c.yellow("No se publicó nada: confirma en la terminal o usa --yes"));
        return 1;
      }
    }

    const result = await unwrap(
      deps.client.listings[":id"].publish.$post({ param: { id: listingId }, json: { platform } }),
      listingPublishResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, trimmed, platform);
    });

    const targets = [...result.started, ...result.requeued];
    // Cada una conserva su modo: una reencolada pudo haberse pedido con otro.
    const modes = new Set(targets.map((publication) => publication.dryRun));
    const mode =
      modes.size > 1
        ? "modo mixto"
        : publicationModeText(targets[0]?.dryRun ?? publishMode !== "live");
    deps.print(
      `Publicando ${trimmed} en ${PLATFORM_TEXT[platform]} (${mode}): ` +
        targets.map((publication) => formatText(platform, publication.format)).join(", "),
    );
    if (result.requeued.length > 0) {
      deps.print(c.dim(`  Ya estaban en curso y se retomaron: ${result.requeued.length}`));
    }
    for (const skipped of result.skipped) {
      deps.printError(
        c.yellow(
          `  El ${formatText(platform, skipped.format)} tiene una publicación activa de un texto anterior (${skipped.publicationId}): retírala o descártala para publicar el nuevo`,
        ),
      );
    }
    if (result.stranded.length > 0) {
      deps.printError(
        c.yellow(
          `  ${result.stranded.length} pendiente(s) de una cuenta desconectada no se publican: descártalas o reconecta la cuenta`,
        ),
      );
    }
    if (options.wait === false) {
      for (const publication of targets) deps.print(publication.id);
      deps.printError(c.dim(`→ Revisa el resultado con: agentsales publications ${trimmed}`));
      return 0;
    }

    // Solo las que empezaron ahora sirven para saber si el worker las tomó: una reencolada ya estaba
    // en curso, y su `updatedAt` no cambia hasta que el worker guarde progreso.
    const startedAt = new Map(result.started.map((p) => [p.id, p.updatedAt.getTime()]));
    const snapshot = (publications: PublicationView[]): PublishWait => ({
      status: publications.some(inProgress) ? "publishing" : "done",
      publications,
    });
    const done = await waitForRun<PublishWait>(deps, {
      run: snapshot(targets),
      fetch: async () =>
        snapshot(
          await Promise.all(
            targets.map(
              async (publication) =>
                (
                  await unwrap(
                    deps.client.publications[":id"].$get({ param: { id: publication.id } }),
                    publicationResponseSchema,
                  )
                ).publication,
            ),
          ),
        ),
      isTerminal: (wait) => wait.status === "done",
      progress: (wait) =>
        wait.publications
          .map((p) => `${formatText(p.platform, p.format)}: ${PUBLICATION_STATUS_TEXT[p.status]}`)
          .join(" · "),
      // Nadie tocó las que empezaron ahora (las publicaciones no tienen `queued`). Es una heurística:
      // con la plataforma lenta, el primer contenedor puede tardar más de 20 s.
      isQueued: (wait) =>
        startedAt.size > 0 &&
        wait.publications.every(
          (p) =>
            !startedAt.has(p.id) ||
            (inProgress(p) && p.updatedAt.getTime() === startedAt.get(p.id)),
        ),
      laterCommand: `agentsales publications ${trimmed}`,
      noun: "la publicación",
    });
    if (done === null) return 1;

    deps.print("");
    for (const publication of done.publications) {
      deps.print(renderPublicationResult(publication, c));
    }
    const failed = done.publications.filter((publication) => publication.status === "failed");
    const changed = done.publications.filter(
      (publication) => publication.status !== "failed" && publication.status !== "published",
    );
    if (failed.length === 0 && changed.length > 0) {
      // Alguien la descartó o la retiró mientras se esperaba.
      deps.printError(
        c.yellow("✗ No todas quedaron publicadas: alguna cambió mientras se esperaba"),
      );
      return 1;
    }
    if (failed.length > 0) {
      deps.printError(
        c.red(`✗ ${failed.length === 1 ? "Una publicación falló" : "Fallaron publicaciones"}`),
      );
      deps.printError(
        c.dim(
          `→ Reintenta con agentsales publish ${trimmed}, o mira la bitácora con agentsales publications ${trimmed} --events`,
        ),
      );
      return 1;
    }
    if (done.publications.every((publication) => publication.dryRun)) {
      deps.print(c.dim("  Simulación: no se envió nada a la plataforma"));
    }
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("publish")
    .description(
      "Publica una propiedad aprobada (Instagram: carrusel y reel; Portal: el aviso) y espera el resultado",
    )
    .argument("<propiedad>", "id_propiedad del Excel, o el id del aviso")
    .option("--platform <canal>", "canal: instagram o portal", "instagram")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--no-wait", "imprime los ids de las publicaciones y sale sin esperar")
    .option("--yes", "no pide confirmación con la API en vivo")
    .action((ref: string, options: PublishOptions) =>
      exitWith(() =>
        runPublish(
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
