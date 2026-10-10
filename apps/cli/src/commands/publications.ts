import {
  listingDetailResponseSchema,
  listingListResponseSchema,
  listingPublicationsResponseSchema,
  MARKETPLACE_URL_MAX_LENGTH,
  type PublicationView,
  publicationConfirmResponseSchema,
  publicationEventsResponseSchema,
  publicationOperationResponseSchema,
  publicationResponseSchema,
  publicationRetireResponseSchema,
  publicationSyncResponseSchema,
} from "@agentsales/api/contracts";
import {
  availablePublicationOperations,
  manualConfirmCommands,
  OPERATION_PLATFORMS,
  PLATFORM_TEXT,
  publicationModeText,
} from "@agentsales/core";
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
  renderRemoteState,
} from "./publication-view.js";
import { fetchBrokers, manualConfirmHint, resolveListingId } from "./shared.js";

export type PublicationsDeps = Io & Pick<Terminal, "confirm"> & { client: ApiClient };

/** `publications confirm --url-stdin` lee además la entrada estándar. */
export type ConfirmDeps = PublicationsDeps & Pick<Terminal, "stdinIsTty" | "readStdin">;

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
function explained(error: unknown, publicationId: string): unknown {
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
  if (error.code === "MANUAL_CONFIRM_PENDING") {
    return new CliError(
      error.code,
      error.apiMessage ?? error.message,
      manualConfirmHint(error.publicationId ?? publicationId),
    );
  }
  if (error.code === "RETIRE_NOT_SUPPORTED") {
    return new CliError(
      "RETIRE_NOT_SUPPORTED",
      error.apiMessage ?? error.message,
      `Un aviso de Portal se cierra: agentsales publications close ${publicationId}`,
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
    const publicationId = publicationIdOf(id);
    const { publication } = await unwrap(
      deps.client.publications[":id"].cancel.$post({ param: { id: publicationId } }),
      publicationResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, publicationId);
    });
    deps.print(
      `${c.green("✓")} ${publicationName(publication)} ${paintPublicationStatus(publication, c)}`,
    );
    return 0;
  });
}

export type RetireOptions = { yes?: boolean };

/**
 * `agentsales publications retire <id> [--yes]` (spec F3 §4.3 y D8, F5 §4.3): Instagram y
 * Marketplace no dejan borrar desde AgentSales, así que una publicada en vivo se borra a mano y
 * aquí se confirma; en simulación no hay nada que borrar. Lee la publicación antes para saber su modo.
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
    // Solo una de Instagram o Marketplace publicada en vivo hay que borrarla a mano; en otro estado
    // (o un aviso de Portal, que se cierra), la API explica por qué no.
    const live =
      !current.dryRun &&
      current.status === "published" &&
      // Los que no se cierran desde AgentSales (Instagram y Marketplace) se borran a mano.
      !OPERATION_PLATFORMS.has(current.platform);
    if (live && !options.yes) {
      const platform = PLATFORM_TEXT[current.platform];
      const where = current.externalUrl === null ? "" : ` (${current.externalUrl})`;
      const confirmed = await deps.confirm(
        `¿Ya borraste a mano en ${platform} el ${publicationName(current)}${where}?`,
      );
      if (!confirmed) {
        deps.printError(
          c.yellow(
            `No se marcó como retirada: bórrala primero en ${platform} y confirma (o usa --yes)`,
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
      throw explained(error, publicationId);
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

export type ConfirmOptions = { urlStdin?: boolean };

/** Los errores de confirmar y de "no lo publiqué", con qué hacer en la CLI. */
function explainedManual(error: unknown, publicationId: string): unknown {
  if (!(error instanceof ApiCallError)) return error;
  const message = error.apiMessage ?? error.message;
  const commands = manualConfirmCommands(publicationId);
  const hints: Record<string, string> = {
    MARKETPLACE_URL_REQUIRED: `Copia el enlace del aviso desde la barra del navegador y corre: ${commands.confirm}`,
    MARKETPLACE_URL_INVALID: `Copia el enlace desde la barra, con el aviso abierto en Facebook, y corre: ${commands.confirm}`,
    PUBLICATION_ALREADY_CONFIRMED:
      "Mira el enlace guardado con agentsales publications <propiedad>",
    INVALID_TRANSITION: "Mira su estado con agentsales publications <propiedad>",
  };
  const hint = error.code === undefined ? undefined : hints[error.code];
  if (hint === undefined) return error;
  return new CliError(error.code ?? "API_ERROR", message, hint);
}

/**
 * `pbpaste | agentsales publications confirm <id> --url-stdin` (spec F5 §4.3 y §4.12): "lo
 * publiqué" de una publicación de Marketplace que espera el clic final. El enlace del aviso llega
 * por la entrada estándar (nunca como argumento: quedaría en el historial) y no se imprime ni se
 * pone en un error. Sin `--url-stdin` solo sirve en simulación (la API pide el enlace en vivo).
 */
export function runConfirmPublication(deps: ConfirmDeps, id: string, options: ConfirmOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const publicationId = publicationIdOf(id);
    const pipe = manualConfirmCommands(publicationId).confirm;
    let url: string | undefined;
    if (options.urlStdin) {
      if (deps.stdinIsTty()) {
        throw new CliError(
          "URL_STDIN_REQUIRED",
          "El enlace va por la entrada estándar, no escrito en la terminal",
          `Copia el enlace del aviso y corre: ${pipe}`,
        );
      }
      url = (await deps.readStdin()).trim();
      if (url === "") {
        throw new CliError("URL_MISSING", "No llegó ningún enlace por la entrada estándar", pipe);
      }
      // Sin mostrar lo recibido: un pegado de otra cosa no se manda a la API.
      if (url.length > MARKETPLACE_URL_MAX_LENGTH || /\s/.test(url)) {
        throw new CliError(
          "URL_INVALID",
          "Lo que llegó por la entrada estándar no parece un enlace (tiene espacios o saltos de línea, o es demasiado largo)",
          "Copia solo el enlace del aviso desde la barra del navegador y vuelve a intentarlo",
        );
      }
    }
    const { publication, changed } = await unwrap(
      deps.client.publications[":id"].confirm.$post({
        param: { id: publicationId },
        json: url === undefined ? {} : { url },
      }),
      publicationConfirmResponseSchema,
    ).catch((error: unknown) => {
      throw explainedManual(error, publicationId);
    });
    deps.print(
      changed
        ? `${c.green("✓")} ${publicationName(publication)} ${paintPublicationStatus(publication, c)} (${publicationModeText(publication.dryRun)})`
        : `${c.green("✓")} Ya estaba confirmada con ese enlace: sin cambios`,
    );
    if (publication.dryRun) {
      deps.print(c.dim("  Simulación: no se publicó nada en Facebook"));
    }
    return 0;
  });
}

/**
 * `agentsales publications not-published <id>` (spec F5 §4.3 y D14): "no lo publiqué" de una de
 * Marketplace que espera el clic final. Queda fallida (no se deshace): se reintenta (abre un
 * formulario nuevo) o se descarta.
 */
export function runNotPublished(deps: PublicationsDeps, id: string) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const publicationId = publicationIdOf(id);
    const { publication } = await unwrap(
      deps.client.publications[":id"]["not-published"].$post({ param: { id: publicationId } }),
      publicationResponseSchema,
    ).catch((error: unknown) => {
      throw explainedManual(error, publicationId);
    });
    deps.print(
      `${c.green("✓")} ${publicationName(publication)} ${paintPublicationStatus(publication, c)}: anotado que no se publicó`,
    );
    deps.printError(
      c.dim(
        `→ Reintenta (abre un formulario nuevo) con agentsales publish <propiedad> --platform marketplace, o descártala con agentsales publications cancel ${publication.id}`,
      ),
    );
    return 0;
  });
}

/** Pausar, reactivar y cerrar un aviso de Portal (spec F4 §4.9): síncronos en la API. */
export type PublicationOperation = "pause" | "resume" | "close";

const OPERATION_TEXT: Readonly<Record<PublicationOperation, { noun: string; done: string }>> = {
  pause: { noun: "La pausa", done: "pausado" },
  resume: { noun: "La reactivación", done: "reactivado" },
  close: { noun: "El cierre", done: "cerrado" },
};

/**
 * La publicación (su modo, estado y nombre) y cómo nombrar su propiedad en las sugerencias: el
 * `id_propiedad` del Excel o, si no se puede leer, el id del aviso (que `publications` también acepta).
 */
async function loadTarget(client: ApiClient, publicationId: string) {
  const { publication } = await unwrap(
    client.publications[":id"].$get({ param: { id: publicationId } }),
    publicationResponseSchema,
  );
  const ref = await unwrap(
    client.listings[":id"].$get({ param: { id: publication.listingId } }),
    listingDetailResponseSchema,
  ).then(
    (detail) => detail.listing.externalRef,
    () => publication.listingId,
  );
  return { publication, ref };
}

/**
 * ¿Se cortó el pedido después de salir? Un tope vencido (`TIMEOUT`, también a mitad de la respuesta)
 * o una conexión cortada sin respuesta: la API pudo haberlo recibido y seguir hasta su tope. Solo
 * `ECONNREFUSED` asegura que no llegó.
 */
const possiblyReceived = (error: ApiCallError) =>
  error.code === "TIMEOUT" || (error.status === undefined && error.code !== "ECONNREFUSED");

/**
 * Los errores de pausar, reactivar, cerrar y actualizar, con qué hacer en la CLI. Si el pedido se
 * cortó después de salir, el cambio pudo aplicarse en Mercado Libre (la API sigue hasta su tope): no
 * se reintenta solo, se dice cómo revisarlo (spec F4-T20). Pedir la lectura (`sync`) no cambia nada
 * allá: solo pudo quedar en cola, y repetirla no duplica nada (la cola es `exclusive`).
 */
function explainedOperation(
  error: unknown,
  target: { publication: PublicationView; ref: string },
  operation: PublicationOperation | "sync",
): unknown {
  if (!(error instanceof ApiCallError)) return error;
  const { publication, ref } = target;
  const look = `agentsales publications ${ref}`;
  const sync = `agentsales publications sync ${publication.id}`;
  if (possiblyReceived(error)) {
    if (operation === "sync") {
      return new CliError(
        "OPERATION_UNCONFIRMED",
        `No se supo si la lectura quedó pedida (${error.message})`,
        `Mira el estado en un momento con ${look}, o repite ${sync}`,
      );
    }
    return new CliError(
      "OPERATION_UNCONFIRMED",
      `${OPERATION_TEXT[operation].noun} pudo haberse aplicado${publication.dryRun ? "" : " en Mercado Libre"}, pero la API no confirmó (${error.message})`,
      publication.dryRun
        ? `No lo repitas todavía: mira el estado con ${look}`
        : `No lo repitas todavía: mira el estado con ${look}, o pide leerlo de Mercado Libre con ${sync}`,
    );
  }
  const message = error.apiMessage ?? error.message;
  const hints: Record<string, string> = {
    INVALID_TRANSITION: `Mira su estado con ${look}`,
    PUBLICATION_NOT_PUBLISHED: `Mira su estado con ${look}`,
    PUBLICATION_IN_PROGRESS: `Espera a que termine (${look}) y vuelve a intentarlo`,
    OPERATION_NOT_SUPPORTED:
      "Una de Instagram se marca como retirada: agentsales publications retire <id>",
    PUBLISH_MODE_MISMATCH:
      "Está publicada en vivo: reinicia la API en vivo (PUBLISH_MODE=live pnpm dev) si lo decides tú",
    CLOSE_NOT_CONFIRMED: "Confirma en la terminal o usa --yes",
    ML_ABORTED: `En un momento, mira el estado con ${look}`,
    ML_CONFLICT: `En un momento, mira el estado con ${look}`,
    ML_UNAVAILABLE: `Mercado Libre no responde: mira el estado en un momento con ${look}`,
    ML_AUTH_INVALID:
      "Reconecta la cuenta: agentsales accounts connect mercadolibre --broker <slug>",
    ACCOUNT_NOT_CONNECTED:
      "Conecta la cuenta: agentsales accounts connect mercadolibre --broker <slug>",
    PUBLISHER_NOT_CONFIGURED:
      "Revisa ML_APP_ID y ML_CLIENT_SECRET en .env con agentsales doctor y reinicia pnpm dev",
  };
  const hint = error.code === undefined ? undefined : hints[error.code];
  if (hint === undefined) return error;
  return new CliError(error.code ?? "API_ERROR", message, hint);
}

export type OperationOptions = { yes?: boolean };

/**
 * `agentsales publications pause|resume|close <id> [--yes]` (spec F4 §4.9 y §4.12): pausa, reactiva
 * o cierra un aviso de Portal y muestra su estado en Mercado Libre. Cerrar una en vivo pregunta
 * antes (es irreversible: volver a publicar crea otro aviso y gasta otro cupo), salvo `--yes`; en
 * simulación no pregunta. Lee la publicación antes para saber su modo.
 */
export function runPublicationOperation(
  deps: PublicationsDeps,
  operation: PublicationOperation,
  id: string,
  options: OperationOptions = {},
) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const target = await loadTarget(deps.client, publicationIdOf(id));
    const { publication: current } = target;
    const text = OPERATION_TEXT[operation];
    // Solo un aviso de Portal en vivo, publicado o pausado (core): en otro caso la API explica.
    const confirmClose =
      operation === "close" && availablePublicationOperations(current).closeNeedsConfirmation;
    if (confirmClose && !options.yes) {
      const where = current.externalUrl === null ? "" : ` (${current.externalUrl})`;
      const confirmed = await deps.confirm(
        `¿Cerrar de verdad el ${publicationName(current)}${where}? Es irreversible: volver a publicar crea un aviso nuevo y usa otro cupo`,
      );
      if (!confirmed) {
        deps.printError(c.yellow("No se cerró: confirma en la terminal o usa --yes"));
        return 1;
      }
    }
    const param = { param: { id: current.id } };
    const request =
      operation === "pause"
        ? deps.client.publications[":id"].pause.$post(param)
        : operation === "resume"
          ? deps.client.publications[":id"].resume.$post(param)
          : deps.client.publications[":id"].close.$post({
              ...param,
              json: confirmClose ? { confirmed: true } : {},
            });
    const { publication, listingBackToReady } = await unwrap(
      request,
      publicationOperationResponseSchema,
    ).catch((error: unknown) => {
      throw explainedOperation(error, target, operation);
    });
    deps.print(
      `${c.green("✓")} ${publicationName(publication)} ${text.done}: ${paintPublicationStatus(publication, c)} (${publicationModeText(publication.dryRun)})`,
    );
    for (const line of renderRemoteState(publication, c)) deps.print(`  ${line}`);
    if (listingBackToReady) {
      deps.print(c.dim("  Era la última publicada en vivo: la propiedad volvió a lista"));
    }
    if (publication.dryRun) {
      deps.print(c.dim("  Simulación: no se cambió nada en Mercado Libre"));
    }
    return 0;
  });
}

/**
 * `agentsales publications sync <id>` (spec F4 §4.9): pide al worker leer el estado del aviso en
 * Mercado Libre. No espera la lectura: dice si quedó pedida o si ya había una programada.
 */
export function runSyncPublication(deps: PublicationsDeps, id: string) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const target = await loadTarget(deps.client, publicationIdOf(id));
    const { queued } = await unwrap(
      deps.client.publications[":id"].sync.$post({ param: { id: target.publication.id } }),
      publicationSyncResponseSchema,
    ).catch((error: unknown) => {
      throw explainedOperation(error, target, "sync");
    });
    deps.print(
      queued
        ? `${c.green("✓")} Se pidió leer el estado del ${publicationName(target.publication)} en Mercado Libre`
        : `${c.green("✓")} Ya hay una lectura programada del ${publicationName(target.publication)} en Mercado Libre`,
    );
    deps.printError(
      c.dim(
        `→ Mira el resultado en un momento con agentsales publications ${target.ref} (el worker tiene que estar corriendo: pnpm dev)`,
      ),
    );
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): ConfirmDeps => ({ ...ctx, client: ctx.api() });
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
    .description(
      "Marca como retirada una publicación (en vivo, después de borrarla en Instagram o Marketplace)",
    )
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .option("--yes", "no pregunta si ya la borraste a mano")
    .action((id: string, options: RetireOptions) =>
      exitWith(() => runRetirePublication(deps(), id, options)),
    );
  publications
    .command("confirm")
    .description(
      "Marketplace: lo publicaste (pega el enlace del aviso: pbpaste | … --url-stdin; no se imprime)",
    )
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .option("--url-stdin", "lee el enlace del aviso desde la entrada estándar (pbpaste | …)")
    .action((id: string, options: ConfirmOptions) =>
      exitWith(() => runConfirmPublication(deps(), id, options)),
    );
  publications
    .command("not-published")
    .description("Marketplace: no lo publicaste (queda fallida, para reintentar o descartar)")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .action((id: string) => exitWith(() => runNotPublished(deps(), id)));
  publications
    .command("pause")
    .description("Pausa un aviso de Portal en Mercado Libre")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .action((id: string) => exitWith(() => runPublicationOperation(deps(), "pause", id)));
  publications
    .command("resume")
    .description("Reactiva un aviso de Portal pausado")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .action((id: string) => exitWith(() => runPublicationOperation(deps(), "resume", id)));
  publications
    .command("close")
    .description("Cierra un aviso de Portal (irreversible; en vivo pide confirmación)")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .option("--yes", "no pide confirmación para cerrar en vivo")
    .action((id: string, options: OperationOptions) =>
      exitWith(() => runPublicationOperation(deps(), "close", id, options)),
    );
  publications
    .command("sync")
    .description("Pide leer el estado de un aviso de Portal en Mercado Libre")
    .argument("<id>", "id de la publicación (agentsales publications <propiedad>)")
    .action((id: string) => exitWith(() => runSyncPublication(deps(), id)));
}
