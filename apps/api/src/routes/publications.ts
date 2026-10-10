import {
  AppError,
  type CancelPublicationDeps,
  cancelPublication,
  closePublication,
  confirmManualPublication,
  isAppError,
  type ListingRepository,
  type MediaRepository,
  type MediaStorage,
  type MercadoLibreAuth,
  markNotPublished,
  type OperatedPublication,
  PENDING_PUBLICATION_STATUSES,
  type Platform,
  type PlatformAccountRepository,
  type PublicationOperations,
  type PublicationRepository,
  type PublishListingDeps,
  type PublishMode,
  pausePublication,
  publishListing,
  type RetirePublicationDeps,
  requestPublicationSync,
  resumePublication,
  retirePublication,
  type StartPublicationDeps,
  startPublication,
} from "@agentsales/core";
import { Hono } from "hono";
import {
  idParamSchema,
  type ListingPublicationsResponse,
  type ListingPublishResponse,
  listingPublishBodySchema,
  type PublicationConfirmResponse,
  type PublicationEventsResponse,
  type PublicationOperationResponse,
  type PublicationPublishResponse,
  type PublicationResponse,
  type PublicationRetireResponse,
  type PublicationSyncResponse,
  publicationCloseBodySchema,
  publicationConfirmBodySchema,
  publicationRetireBodySchema,
} from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { validated } from "../validation.js";
import { contentMedia } from "./content.js";
import { actorOf, eventView, publicationView, skippedView } from "./publication-views.js";

export type PublicationRoutesDeps = PublishListingDeps &
  StartPublicationDeps &
  CancelPublicationDeps &
  RetirePublicationDeps & {
    /**
     * Fuera del candado solo se lee: los cambios de estado van dentro, con sus repositorios
     * (ADR-0014). El tipo lo hace cumplir.
     */
    publications: Pick<PublicationRepository, "get" | "listByListing" | "listEvents">;
    listings: Pick<ListingRepository, "get">;
    media: Pick<MediaRepository, "listByListing">;
    /** Solo para las miniaturas de `GET /listings/:id/publications` (R2 es privado, ADR-0007). */
    storage: Pick<MediaStorage, "signedReadUrl">;
    /** El modo de los intentos que se piden por la API (D11): nunca sale del cuerpo. */
    publishMode: PublishMode;
    /**
     * Pausar, reactivar y cerrar (spec F4 §4.9): las operaciones de cada plataforma (Portal:
     * `createPortalOperations` con el tope de 10 s por llamada, que compone `server.ts`), el token
     * de Portal (`ensureAccessToken`, con el candado de credenciales) y el refresco de Mercado Libre
     * (`null` sin el par de la app).
     */
    operationsFor(platform: Platform): PublicationOperations | undefined;
    platformAccounts: Pick<
      PlatformAccountRepository,
      "get" | "getCredentials" | "changeStatus" | "withCredentialsLock"
    >;
    mercadoLibreRefresh: Pick<MercadoLibreAuth, "refresh"> | null;
    logger: AppLogger;
    /** Por defecto `OPERATION_TIMEOUT_MS`; los tests lo bajan para ver el corte. */
    operationTimeoutMs?: number;
  };

/**
 * Tope de una operación desde la API (spec F4 §4.9 y T19). La señal corta las llamadas a Mercado
 * Libre, pero no la espera del candado de credenciales (hasta 10 s) ni un refresco ya enviado
 * (hasta 10 s: cortarlo perdería el par rotado, ADR-0015). Peor caso: una llamada que se cuelga y
 * da 401 cerca del tope, más el candado y el refresco, unos 25 s más la base: bajo los 30 s de la
 * CLI y los 35 s del panel. Al vencer se corta (`ML_ABORTED`) y la operación pide un sync.
 */
export const OPERATION_TIMEOUT_MS = 15_000;

/**
 * Mensajes propios de pausar, reactivar y cerrar cuando la operación ya pidió el sync (spec F4
 * §4.9): el de la plataforma habla de la llamada; el operador necesita saber qué pasa con el estado.
 * Sin nombrar botones ni comandos: cada interfaz pone su salida (Actualizar en el panel,
 * `publications` en la CLI; desde F4-T20).
 */
const OPERATION_MESSAGES: Readonly<Record<string, string>> = {
  ML_ABORTED:
    "Mercado Libre tardó demasiado en responder: AgentSales revisará el estado en un momento",
  ML_CONFLICT:
    "Mercado Libre está procesando otro cambio del aviso: AgentSales revisará el estado en un momento",
};

/** Relanza el error de una operación con el mensaje propio, si lo tiene (mismo código). */
function operationError(error: unknown): unknown {
  if (!isAppError(error)) return error;
  const message = OPERATION_MESSAGES[error.code];
  return message === undefined
    ? error
    : new AppError(error.code, message, {
        retriable: error.retriable,
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
}

const pending = new Set<string>(PENDING_PUBLICATION_STATUSES);

const publicationNotFound = (id: string) =>
  new AppError("PUBLICATION_NOT_FOUND", `No existe la publicación ${id}`, {
    details: { publicationId: id },
  });

const dryRunOf = (deps: Pick<PublicationRoutesDeps, "publishMode">) => deps.publishMode !== "live";

/**
 * Publicar y mirar las publicaciones de un aviso (spec F3 §4.3 y §4.8): `GET` y `POST` bajo
 * `/listings/:id`. Se montan en `/listings`, junto a `listingRoutes`.
 */
export function listingPublicationRoutes(deps: PublicationRoutesDeps) {
  const signed = contentMedia(deps.storage);
  return new Hono()
    .get("/:id/publications", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      if ((await deps.listings.get(id)) === null) {
        throw new AppError("LISTING_NOT_FOUND", `No existe el aviso ${id}`, {
          details: { listingId: id },
        });
      }
      const [publications, media] = await Promise.all([
        deps.publications.listByListing(id),
        deps.media.listByListing(id),
      ]);
      // Cada medio se firma una vez, aunque lo compartan varias publicaciones. Solo los que siguen
      // en R2 y no son originales (una publicación fija derivados y renders), y solo para las
      // pendientes: en las demás, una corrida posterior pudo reemplazar la imagen en el mismo medio.
      const thumbnails = new Map(
        media.filter((item) => item.variant !== null).map((item) => [item.id, signed(item)]),
      );
      const body: ListingPublicationsResponse = {
        publications: await Promise.all(
          publications.map(async (publication) => ({
            ...publicationView(publication),
            media: pending.has(publication.status)
              ? await Promise.all(
                  publication.mediaIds.flatMap((mediaId) => thumbnails.get(mediaId) ?? []),
                )
              : [],
          })),
        ),
      };
      return c.json(body, 200);
    })
    .post(
      "/:id/publish",
      validated("param", idParamSchema),
      validated("json", listingPublishBodySchema),
      async (c) => {
        const platform: Platform = c.req.valid("json").platform;
        const result = await publishListing(deps, {
          listingId: c.req.valid("param").id,
          platform,
          dryRun: dryRunOf(deps),
          actor: actorOf(c),
        });
        const body: ListingPublishResponse = {
          started: result.started.map(publicationView),
          requeued: result.requeued.map(publicationView),
          created: result.created.map(publicationView),
          skipped: result.skipped.map(skippedView),
          stranded: result.stranded.map(publicationView),
          publications: result.publications.map(publicationView),
        };
        return c.json(body, 202);
      },
    );
}

/** Las dependencias de pausar, reactivar y cerrar, con el modo de la API y los avisos al log. */
const operationDeps = (deps: PublicationRoutesDeps) => ({
  lock: deps.lock,
  queue: deps.queue,
  publications: deps.publications,
  platformAccounts: deps.platformAccounts,
  mercadoLibre: deps.mercadoLibreRefresh,
  operationsFor: deps.operationsFor,
  apiMode: deps.publishMode,
  // Solo el paso y el código: nunca el token ni datos del aviso.
  onWarning: ({
    publicationId,
    step,
    code,
  }: {
    publicationId: string;
    step: string;
    code: string;
  }) => deps.logger.warn({ publicationId, step, code }, "un paso secundario de la operación falló"),
});

const operationBody = (result: OperatedPublication): PublicationOperationResponse => ({
  publication: publicationView(result.publication),
  listingBackToReady: result.listingBackToReady,
});

/**
 * `/publications/:id`: publicar o reintentar una, descartarla, marcarla como retirada y su
 * bitácora (spec F3 §4.3 y §4.8); pausar, reactivar, cerrar y pedir el sync de una de Portal (spec
 * F4 §4.9); "lo publiqué" (con el enlace) y "no lo publiqué" de una de Marketplace que espera el
 * clic final (spec F5 §4.3). El enlace pegado nunca vuelve en un error ni va al log (el log de la
 * API no registra cuerpos, y `parseMarketplaceItemUrl` no lo repite). Cambian el estado dentro del candado del aviso (core); publicar y el sync encolan
 * después. Pausar, reactivar y cerrar son síncronos: llaman a la plataforma (fuera del candado) con
 * un tope de `OPERATION_TIMEOUT_MS`.
 */
export function publicationRoutes(deps: PublicationRoutesDeps) {
  const operations = operationDeps(deps);
  const timeout = () => AbortSignal.timeout(deps.operationTimeoutMs ?? OPERATION_TIMEOUT_MS);
  const operate = async (run: () => Promise<OperatedPublication>) => {
    try {
      return operationBody(await run());
    } catch (error) {
      throw operationError(error);
    }
  };
  return new Hono()
    .get("/:id", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const publication = await deps.publications.get(id);
      if (publication === null) throw publicationNotFound(id);
      const body: PublicationResponse = { publication: publicationView(publication) };
      return c.json(body, 200);
    })
    .post("/:id/publish", validated("param", idParamSchema), async (c) => {
      const { publication, requeued } = await startPublication(deps, {
        publicationId: c.req.valid("param").id,
        dryRun: dryRunOf(deps),
        actor: actorOf(c),
      });
      const body: PublicationPublishResponse = {
        publication: publicationView(publication),
        requeued,
      };
      return c.json(body, 202);
    })
    .post("/:id/cancel", validated("param", idParamSchema), async (c) => {
      const publication = await cancelPublication(deps, {
        publicationId: c.req.valid("param").id,
        actor: actorOf(c),
      });
      const body: PublicationResponse = { publication: publicationView(publication) };
      return c.json(body, 200);
    })
    .post(
      "/:id/retire",
      validated("param", idParamSchema),
      validated("json", publicationRetireBodySchema),
      async (c) => {
        const { removedByHand } = c.req.valid("json");
        const result = await retirePublication(deps, {
          publicationId: c.req.valid("param").id,
          actor: actorOf(c),
          ...(removedByHand === undefined ? {} : { removedByHand }),
        });
        const body: PublicationRetireResponse = {
          publication: publicationView(result.publication),
          listingBackToReady: result.listingBackToReady,
        };
        return c.json(body, 200);
      },
    )
    .post("/:id/pause", validated("param", idParamSchema), async (c) => {
      const body = await operate(() =>
        pausePublication(operations, {
          publicationId: c.req.valid("param").id,
          actor: actorOf(c),
          signal: timeout(),
        }),
      );
      return c.json(body, 200);
    })
    .post("/:id/resume", validated("param", idParamSchema), async (c) => {
      const body = await operate(() =>
        resumePublication(operations, {
          publicationId: c.req.valid("param").id,
          actor: actorOf(c),
          signal: timeout(),
        }),
      );
      return c.json(body, 200);
    })
    .post(
      "/:id/close",
      validated("param", idParamSchema),
      validated("json", publicationCloseBodySchema),
      async (c) => {
        const { confirmed } = c.req.valid("json");
        const body = await operate(() =>
          closePublication(operations, {
            publicationId: c.req.valid("param").id,
            actor: actorOf(c),
            ...(confirmed === undefined ? {} : { confirmed }),
            signal: timeout(),
          }),
        );
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/confirm",
      validated("param", idParamSchema),
      validated("json", publicationConfirmBodySchema),
      async (c) => {
        const { url } = c.req.valid("json");
        const { publication, changed } = await confirmManualPublication(deps, {
          publicationId: c.req.valid("param").id,
          actor: actorOf(c),
          ...(url === undefined ? {} : { url }),
        });
        const body: PublicationConfirmResponse = {
          publication: publicationView(publication),
          changed,
        };
        return c.json(body, 200);
      },
    )
    .post("/:id/not-published", validated("param", idParamSchema), async (c) => {
      const publication = await markNotPublished(deps, {
        publicationId: c.req.valid("param").id,
        actor: actorOf(c),
      });
      const body: PublicationResponse = { publication: publicationView(publication) };
      return c.json(body, 200);
    })
    .post("/:id/sync", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const { queued } = await requestPublicationSync(deps, { publicationId: id });
      const body: PublicationSyncResponse = { publicationId: id, queued };
      return c.json(body, 202);
    })
    .get("/:id/events", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      if ((await deps.publications.get(id)) === null) throw publicationNotFound(id);
      const events = await deps.publications.listEvents(id);
      const body: PublicationEventsResponse = { events: events.map(eventView) };
      return c.json(body, 200);
    });
}
