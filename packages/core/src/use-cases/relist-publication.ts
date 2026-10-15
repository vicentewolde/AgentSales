import type { PublishMode } from "../enums.js";
import { AppError } from "../errors.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { ListingLock } from "../ports/listing-lock.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import type { Publication, PublicationActor } from "../publication.js";
import { createPublications } from "./open-publications.js";
import {
  enqueuePublications,
  type MarketplaceStartOptions,
  type PortalCheckDeps,
  portalDefinitionsBeforeLock,
  publicationNotFound,
  startOne,
} from "./publication-start.js";
import { prepareChannelStart } from "./start-checks.js";

export type RelistPublicationDeps = PortalCheckDeps & {
  lock: ListingLock;
  queue: JobQueue;
  /** Fuera del candado: la publicación que se republica. */
  publications: Pick<PublicationRepository, "get">;
  marketplace?: MarketplaceStartOptions;
  now?: () => Date;
};

const notAllowed = (publicationId: string, message: string) =>
  new AppError("RELIST_NOT_ALLOWED", message, { details: { publicationId } });

/**
 * Republicar un aviso de Portal vencido o cerrado (`POST /publications/:id/relist`, spec F6 §4.7,
 * ADR-0020). Crea una publicación **nueva** desde el texto de Portal aprobado y la propiedad de hoy,
 * con `relisted_from` = la anterior (que queda con su historia), y la pasa a `publishing` con el
 * modo de la API; después del candado la encola. El publisher, con la anterior en vivo, llama a
 * `relist` sobre su ítem (conserva las visitas si fue hace 60 días o menos) en vez de crear uno.
 * Revisa:
 * - la anterior es de Portal y está `unpublished` (si no, `RELIST_NOT_ALLOWED`);
 * - los modos no se cruzan: una simulación no se republica con la API en vivo (su ítem no existe,
 *   `RELIST_NOT_ALLOWED`) y una en vivo no se republica en simulación (`PUBLISH_MODE_MISMATCH`);
 * - en vivo, que Mercado Libre la haya dejado cerrada (`remote_state`: `RELIST_NOT_ALLOWED`) y la
 *   confirmación (`RELIST_NOT_CONFIRMED`: usa un cupo del paquete);
 * - lo mismo que publicar el canal (la propiedad, el texto aprobado y sin errores, la cuenta, lo
 *   que pide Portal), y que no haya otra publicación activa de Portal de esa cuenta (publícala o
 *   descártala antes: `RELIST_NOT_ALLOWED`). Un segundo `relist` de la misma anterior lo impide el
 *   único de `relisted_from` (`PUBLICATION_CONFLICT`).
 */
export async function relistPublication(
  deps: RelistPublicationDeps,
  {
    publicationId,
    dryRun,
    actor,
    confirmed = false,
  }: { publicationId: string; dryRun: boolean; actor: PublicationActor; confirmed?: boolean },
): Promise<Publication> {
  const previous = await deps.publications.get(publicationId);
  if (previous === null) throw publicationNotFound(publicationId);
  if (previous.platform !== "portal_inmobiliario" || previous.status !== "unpublished") {
    throw notAllowed(publicationId, "Solo se republica un aviso de Portal cerrado o vencido");
  }
  requireRelistMode(previous, dryRun, confirmed);
  const definitions = await portalDefinitionsBeforeLock(
    deps,
    previous.listingId,
    previous.platform,
  );

  const started = await deps.lock.run(previous.listingId, async (locked) => {
    const { listing, content, opening, startable } = await prepareChannelStart(
      locked,
      { listingId: previous.listingId, platform: previous.platform },
      {
        dryRun,
        definitions,
        marketplace: deps.marketplace ?? {},
        now: (deps.now ?? (() => new Date()))(),
        manualLimits: true,
        countInFlight: true,
        nothingMessage: "Ya hay un aviso de Portal activo de esta propiedad",
      },
    );
    const planned = opening.toCreate.filter(
      (item) => item.platformAccountId === previous.platformAccountId,
    );
    const busy = startable.some((item) => item.platformAccountId === previous.platformAccountId);
    if (planned.length !== 1 || busy) {
      throw notAllowed(
        publicationId,
        "Ya hay otra publicación de Portal de esta propiedad en la cuenta: publícala o descártala antes de republicar",
      );
    }
    const [created] = await createPublications(locked, {
      listing,
      content,
      planned,
      actor,
      relistedFrom: previous.id,
    });
    if (created === undefined) throw notAllowed(publicationId, "No se pudo crear la republicación");
    return startOne(locked.publications, created, { dryRun, actor });
  });

  await enqueuePublications(deps.queue, [started]);
  return started;
}

/** Los modos de republicar (ADR-0020): nunca se cruzan, y en vivo hace falta el cierre y la confirmación. */
function requireRelistMode(previous: Publication, dryRun: boolean, confirmed: boolean): void {
  const mode: PublishMode = dryRun ? "dry-run" : "live";
  if (previous.dryRun && mode === "live") {
    throw notAllowed(
      previous.id,
      "Ese aviso era una simulación: no existe en Mercado Libre. Publica uno nuevo en vez de republicarlo",
    );
  }
  if (!previous.dryRun && mode === "dry-run") {
    throw new AppError(
      "PUBLISH_MODE_MISMATCH",
      "Ese aviso estuvo en vivo, pero AgentSales está en simulación: no se republica",
      { details: { publicationId: previous.id } },
    );
  }
  if (mode === "live") {
    if (previous.externalId === null || previous.remoteState?.status !== "closed") {
      throw notAllowed(
        previous.id,
        "Mercado Libre no dice que el aviso esté cerrado o vencido: pide leer su estado en Mercado Libre y vuelve a intentarlo",
      );
    }
    if (!confirmed) {
      throw new AppError(
        "RELIST_NOT_CONFIRMED",
        "Republicar crea un aviso nuevo en Mercado Libre y usa un cupo del paquete: confirma que quieres republicarlo",
        { details: { publicationId: previous.id } },
      );
    }
  }
}
