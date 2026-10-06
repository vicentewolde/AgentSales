import {
  listingListResponseSchema,
  listingPublicationsResponseSchema,
  type PublicationView,
  publicationEventsResponseSchema,
  publicationResponseSchema,
  publicationRetireResponseSchema,
} from "@agentsales/api/contracts";
import type { Command } from "commander";
import { z } from "zod";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import {
  paintPublicationStatus,
  publicationName,
  renderPublicationEvents,
  renderPublications,
} from "./publication-view.js";
import { fetchBrokers, resolveListingId } from "./shared.js";

export type PublicationsDeps = Io & Pick<Terminal, "confirm"> & { client: ApiClient };

export type PublicationsOptions = { broker?: string; events?: boolean };

/** El id de una publicación: un uuid, como lo muestra `agentsales publications <propiedad>`. */
function publicationIdOf(id: string): string {
  const trimmed = id.trim();
  if (!z.uuid().safeParse(trimmed).success) {
    throw new CliError(
      "PUBLICATION_ID_INVALID",
      `"${id}" no es el id de una publicación`,
      "Mira los ids con agentsales publications <propiedad>",
    );
  }
  return trimmed;
}

/** Los 409 de descartar y retirar, con qué hacer en la CLI. */
function explained(error: unknown): unknown {
  if (!(error instanceof ApiCallError)) return error;
  if (error.code === "PUBLICATION_IN_PROGRESS") {
    return new CliError(
      "PUBLICATION_IN_PROGRESS",
      error.apiMessage ?? error.message,
      "Espera a que termine (agentsales publications <propiedad>) y vuelve a intentarlo",
    );
  }
  if (error.code === "INVALID_TRANSITION") {
    return new CliError(
      "INVALID_TRANSITION",
      error.apiMessage ?? error.message,
      "Una publicada se marca como retirada (publications retire); una pendiente se descarta (publications cancel)",
    );
  }
  return error;
}

async function listingPublications(client: ApiClient, listingId: string) {
  const { publications } = await unwrap(
    client.listings[":id"].publications.$get({ param: { id: listingId } }),
    listingPublicationsResponseSchema,
  );
  return publications;
}

async function printEvents(deps: PublicationsDeps, publications: readonly PublicationView[]) {
  const c = deps.colors;
  for (const publication of publications) {
    const { events } = await unwrap(
      deps.client.publications[":id"].events.$get({ param: { id: publication.id } }),
      publicationEventsResponseSchema,
    );
    deps.print("");
    deps.print(c.bold(`Bitácora de ${publication.id} (${publicationName(publication)})`));
    deps.print(renderPublicationEvents(events, c));
  }
}

/**
 * `agentsales publications [<propiedad>] [--events]` (spec F3 §4.9): las publicaciones de una
 * propiedad (o de todas) con su estado, formato, modo y enlace; `--events` suma la bitácora.
 */
export function runPublications(
  deps: PublicationsDeps,
  ref: string | undefined,
  options: PublicationsOptions = {},
) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const brokers = await fetchBrokers(deps.client);
    if (ref !== undefined) {
      const trimmed = ref.trim();
      const listingId = await resolveListingId(deps.client, trimmed, brokers, options.broker);
      const publications = await listingPublications(deps.client, listingId);
      if (publications.length === 0) {
        deps.print(
          c.yellow(`${trimmed} no tiene publicaciones: aprueba su texto con agentsales approve`),
        );
        return 0;
      }
      deps.print(c.bold(`Publicaciones de ${trimmed}`));
      deps.print(renderPublications(publications, c));
      if (options.events) await printEvents(deps, publications);
      return 0;
    }

    const { listings } = await unwrap(
      deps.client.listings.$get({ query: {} }),
      listingListResponseSchema,
    );
    let shown = 0;
    for (const listing of listings) {
      const publications = await listingPublications(deps.client, listing.id);
      if (publications.length === 0) continue;
      const broker = brokers.get(listing.brokerId)?.slug ?? listing.brokerId;
      if (shown > 0) deps.print("");
      deps.print(c.bold(`${listing.externalRef} (${broker})`));
      deps.print(renderPublications(publications, c));
      if (options.events) await printEvents(deps, publications);
      shown += 1;
    }
    if (shown === 0) deps.print(c.yellow("No hay publicaciones todavía"));
    return 0;
  });
}

/** `agentsales publications cancel <id>`: descarta una publicación que no salió. */
export function runCancelPublication(deps: PublicationsDeps, id: string) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const { publication } = await unwrap(
      deps.client.publications[":id"].cancel.$post({ param: { id: publicationIdOf(id) } }),
      publicationResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error);
    });
    deps.print(
      `${c.green("✓")} ${publicationName(publication)} ${paintPublicationStatus(publication, c)}`,
    );
    return 0;
  });
}

export type RetireOptions = { yes?: boolean };

/**
 * `agentsales publications retire <id> [--yes]` (spec F3 §4.3 y D8): Instagram Login no deja borrar
 * por la API, así que una publicada en vivo se borra a mano en Instagram y aquí se confirma; en
 * simulación no hay nada que borrar. Lee la publicación antes para saber su modo.
 */
export function runRetirePublication(
  deps: PublicationsDeps,
  id: string,
  options: RetireOptions = {},
) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const publicationId = publicationIdOf(id);
    const { publication: current } = await unwrap(
      deps.client.publications[":id"].$get({ param: { id: publicationId } }),
      publicationResponseSchema,
    );
    // Solo una publicada en vivo hay que borrarla a mano; en otro estado, la API explica por qué no.
    const live = !current.dryRun && current.status === "published";
    if (live && !options.yes) {
      const where = current.externalUrl === null ? "" : ` (${current.externalUrl})`;
      const confirmed = await deps.confirm(
        `¿Ya borraste a mano en Instagram el ${publicationName(current)}${where}?`,
      );
      if (!confirmed) {
        deps.printError(
          c.yellow(
            "No se marcó como retirada: bórrala primero en Instagram y confirma (o usa --yes)",
          ),
        );
        return 1;
      }
    }
    const { publication, listingBackToReady } = await unwrap(
      deps.client.publications[":id"].retire.$post({
        param: { id: publicationId },
        json: live ? { removedByHand: true } : {},
      }),
      publicationRetireResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error);
    });
    deps.print(
      `${c.green("✓")} ${publicationName(publication)} ${paintPublicationStatus(publication, c)}`,
    );
    if (listingBackToReady) {
      deps.print(c.dim("  Era la última publicada en vivo: la propiedad volvió a lista"));
    }
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): PublicationsDeps => ({ ...ctx, client: ctx.api() });
  const publications = program
    .command("publications")
    .description("Publicaciones de una propiedad (o de todas): estado, formato, modo y enlace")
    .argument("[propiedad]", "id_propiedad del Excel, o el id del aviso")
    .option("--broker <slug>", "corredor, si el id_propiedad está en más de uno")
    .option("--events", "muestra también la bitácora de cada publicación")
    .action((ref: string | undefined, options: PublicationsOptions) =>
      exitWith(() => runPublications(deps(), ref, options)),
    );
  publications
    .command("cancel")
    .description("Descarta una publicación que no salió (el texto sigue aprobado)")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .action((id: string) => exitWith(() => runCancelPublication(deps(), id)));
  publications
    .command("retire")
    .description("Marca como retirada una publicación (en vivo, después de borrarla en Instagram)")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .option("--yes", "no pregunta si ya la borraste a mano en Instagram")
    .action((id: string, options: RetireOptions) =>
      exitWith(() => runRetirePublication(deps(), id, options)),
    );
}
