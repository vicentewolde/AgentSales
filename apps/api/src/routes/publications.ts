import {
  AppError,
  type BrokerRepository,
  type CancelPublicationDeps,
  type ContentRepository,
  cancelPublication,
  closePublication,
  confirmManualPublication,
  isAppError,
  type ListingRepository,
  listingSubject,
  type MediaRepository,
  type MediaStorage,
  type MercadoLibreAuth,
  markNotPublished,
  type OperatedPublication,
  PENDING_PUBLICATION_STATUSES,
  type Platform,
  type PlatformAccountRepository,
  type PlatformTokenRefresher,
  type PublicationOperations,
  type PublicationRepository,
  type PublishListingDeps,
  type PublishMode,
  pausePublication,
  publishListing,
  type RetirePublicationDeps,
  relistPublication,
  requestPublicationSync,
  resolvePublication,
  resumePublication,
  retirePublication,
  type StartPublicationDeps,
  schedulePublication,
  startPublication,
  type UserRepository,
  unschedulePublication,
  updatePortalPublication,
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
  publicationConfirmedBodySchema,
  publicationResolveBodySchema,
  publicationRetireBodySchema,
  publicationScheduleBodySchema,
} from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { validated } from "../validation.js";
import { contentMedia } from "./content.js";
import {
  actorOf,
  eventViewWith,
  publicationView,
  publicationViewAt,
  skippedView,
} from "./publication-views.js";

export type PublicationRoutesDeps = PublishListingDeps &
  StartPublicationDeps &
  CancelPublicationDeps &
  RetirePublicationDeps & {
    /**
     * Fuera del candado solo se lee: los cambios de estado van dentro, con sus repositorios
     * (ADR-0014). El tipo lo hace cumplir.
     */
    publications: Pick<PublicationRepository, "get" | "listBySubject" | "listEvents">;
    /** `getSourceHash`: Actualizar compara la versión de la propiedad (F6-T07). */
    listings: Pick<ListingRepository, "get" | "getSourceHash">;
    /** Actualizar en Portal (F6-T07): el texto vigente y el contacto del corredor. */
    contents: Pick<ContentRepository, "listCurrent">;
    brokers: Pick<BrokerRepository, "findById">;
    /** El nombre de cada persona de la bitácora (spec F7 §4.3). */
    auth: { users: Pick<UserRepository, "get"> };
    media: Pick<MediaRepository, "listBySubject">;
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
    /**
     * F9.5-T09: la renovación de los tokens que rotan (X), para retirar borrando con
     * `ensureRotatingAccessToken`. La compone `createApp` (la misma del refresco a pedido); sin la
     * de una red, un token por vencer es `TOKEN_REFRESH_NOT_CONFIGURED`.
     */
    tokenRefreshers?: Readonly<Partial<Record<Platform, PlatformTokenRefresher>>>;
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
export function operationError(error: unknown): unknown {
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
        deps.publications.listBySubject(listingSubject(id)),
        deps.media.listBySubject(listingSubject(id)),
      ]);
      // Cada medio se firma una vez, aunque lo compartan varias publicaciones. Solo los que siguen
      // en R2 y no son originales (una publicación fija derivados y renders), y solo para las
      // pendientes: en las demás, una corrida posterior pudo reemplazar la imagen en el mismo medio.
      const thumbnails = new Map(
        media.filter((item) => item.variant !== null).map((item) => [item.id, signed(item)]),
      );
      const at = deps.now?.() ?? new Date();
      const body: ListingPublicationsResponse = {
        publications: await Promise.all(
          publications.map(async (publication) => ({
            ...publicationViewAt(publication, at),
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
export const operationDeps = (
  deps: Pick<
    PublicationRoutesDeps,
    | "lock"
    | "queue"
    | "publications"
    | "platformAccounts"
    | "mercadoLibreRefresh"
    | "operationsFor"
    | "publishMode"
    | "logger"
  >,
) => ({
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
 * API no registra cuerpos, y `parseMarketplaceItemUrl` no lo repite). Cambian el estado dentro del
 * candado del aviso (core); publicar y el sync encolan después. Pausar, reactivar y cerrar son
 * síncronos: llaman a la plataforma (fuera del candado) con un tope de `OPERATION_TIMEOUT_MS`.
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
    .post(
      "/:id/schedule",
      validated("param", idParamSchema),
      validated("json", publicationScheduleBodySchema),
      async (c) => {
        // Programar o reprogramar (spec F6 §4.3): el modo es el de la API ahora (D11).
        const publication = await schedulePublication(deps, {
          publicationId: c.req.valid("param").id,
          at: new Date(c.req.valid("json").at),
          dryRun: dryRunOf(deps),
          actor: actorOf(c),
        });
        const body: PublicationResponse = { publication: publicationView(publication) };
        return c.json(body, 200);
      },
    )
    .post("/:id/unschedule", validated("param", idParamSchema), async (c) => {
      const publication = await unschedulePublication(deps, {
        publicationId: c.req.valid("param").id,
        actor: actorOf(c),
      });
      const body: PublicationResponse = { publication: publicationView(publication) };
      return c.json(body, 200);
    })
    .post(
      "/:id/update",
      validated("param", idParamSchema),
      validated("json", publicationConfirmedBodySchema),
      async (c) => {
        // Actualizar un aviso de Portal publicado (spec F6 §4.7, ADR-0020): síncrona, como cerrar.
        const { confirmed } = c.req.valid("json");
        let publication: Awaited<ReturnType<typeof updatePortalPublication>>;
        try {
          publication = await updatePortalPublication(
            {
              ...operations,
              contents: deps.contents,
              listings: deps.listings,
              brokers: deps.brokers,
            },
            {
              publicationId: c.req.valid("param").id,
              actor: actorOf(c),
              ...(confirmed === undefined ? {} : { confirmed }),
              signal: timeout(),
            },
          );
        } catch (error) {
          throw operationError(error);
        }
        const body: PublicationResponse = { publication: publicationView(publication) };
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/relist",
      validated("param", idParamSchema),
      validated("json", publicationConfirmedBodySchema),
      async (c) => {
        // Republicar un aviso de Portal vencido o cerrado (spec F6 §4.7): crea la nueva y la encola.
        const { confirmed } = c.req.valid("json");
        const publication = await relistPublication(deps, {
          publicationId: c.req.valid("param").id,
          dryRun: dryRunOf(deps),
          actor: actorOf(c),
          ...(confirmed === undefined ? {} : { confirmed }),
        });
        const body: PublicationResponse = { publication: publicationView(publication) };
        return c.json(body, 202);
      },
    )
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
        const { removedByHand, deleteRemote } = c.req.valid("json");
        // F9-T19: borrar por la API (LinkedIn en modo `api`; X desde F9.5-T09, con su token
        // renovado bajo el candado de credenciales) es síncrono, con el tope de las operaciones;
        // el modo lo decide la publicación y la API (nunca en simulación).
        const result = await retirePublication(
          {
            ...deps,
            removal: {
              apiMode: deps.publishMode,
              platformAccounts: deps.platformAccounts,
              operationsFor: deps.operationsFor,
              refreshers: deps.tokenRefreshers ?? {},
              ...(deps.now === undefined ? {} : { now: deps.now }),
              onWarning: operations.onWarning,
            },
          },
          {
            publicationId: c.req.valid("param").id,
            actor: actorOf(c),
            ...(removedByHand === undefined ? {} : { removedByHand }),
            ...(deleteRemote === undefined ? {} : { deleteRemote }),
            ...(deleteRemote === true ? { signal: timeout() } : {}),
          },
        );
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
    .post(
      "/:id/resolve",
      validated("param", idParamSchema),
      validated("json", publicationResolveBodySchema),
      async (c) => {
        // Resultado dudoso (ADR-0029 punto 8, F9-T12): el operador dice si salió o no. Como
        // `confirm`, el enlace nunca vuelve en un error ni va al log. Como `confirm` y `publish`,
        // en una publicación de post solo pasa por `ownedBy` (lo ajeno es 404), sin revisar
        // `posts.manage`: hoy el administrador y el corredor lo tienen; si un rol lo pierde, la
        // revisión va aquí (o en core) para todo `/publications/:id/*`.
        const { outcome, url } = c.req.valid("json");
        const { publication, changed } = await resolvePublication(deps, {
          publicationId: c.req.valid("param").id,
          outcome,
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
      // El nombre de cada persona de la bitácora (spec F7 §4.3), una consulta por persona distinta.
      const names = new Map<string, string>();
      for (const userId of new Set(events.flatMap((event) => event.userId ?? []))) {
        const user = await deps.auth.users.get(userId);
        if (user !== null) names.set(userId, user.name);
      }
      const body: PublicationEventsResponse = { events: events.map(eventViewWith(names)) };
      return c.json(body, 200);
    });
}
