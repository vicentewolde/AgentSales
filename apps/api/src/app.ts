import {
  AppError,
  type Broker,
  type BrokerRepository,
  type ContentRepository,
  type ContentRunRepository,
  type EditorialProfileRepository,
  type FieldDefinitionRepository,
  type HealthCheckName,
  type ImportRunRepository,
  type JobQueue,
  type ListingLock,
  type ListingRepository,
  type LogoNormalizer,
  type MarketplaceStartOptions,
  type MediaRepository,
  type MediaStorage,
  type MercadoLibreAuth,
  type MetaDeletionRepository,
  type OAuthStateRepository,
  type Platform,
  type PlatformAccountRepository,
  type PostLock,
  type PostRepository,
  type PublicationOperations,
  type PublicationRepository,
  type PublishMode,
  type Subject,
} from "@agentsales/core";
import { Hono, type MiddlewareHandler } from "hono";
import { API_PREFIX } from "./access.js";
import { type AppEnv, type AuthDeps, authenticate, sessionCookieName } from "./auth.js";
import { createErrorHandler, notFoundHandler } from "./errors.js";
import { type HealthCheck, type HealthDetails, runHealth } from "./health.js";
import type { AppLogger } from "./logger.js";
import { type RateLimitDeps, rateLimitByIp, rateLimitByUser } from "./rate-limit.js";
import { type RequestContext, withEventUser, withPostEventUser } from "./request-context.js";
import { requestLogger } from "./request-logger.js";
import { accountRoutes } from "./routes/accounts.js";
import { authRoutes } from "./routes/auth.js";
import { brokerRoutes } from "./routes/brokers.js";
import { contentRoutes, contentRunRoutes, listingContentRoutes } from "./routes/content.js";
import { editorialProfileRoutes } from "./routes/editorial-profile.js";
import { importRoutes } from "./routes/imports.js";
import { listingRoutes } from "./routes/listings.js";
import { type MetaSignatureVerifier, metaRoutes } from "./routes/meta.js";
import { type OAuthDeps, oauthRoutes } from "./routes/oauth.js";
import {
  listingPublicationRoutes,
  operationDeps,
  publicationRoutes,
} from "./routes/publications.js";
import { scheduleRoutes } from "./routes/schedule.js";
import { trackingRoutes } from "./routes/tracking.js";
import { usageRoutes } from "./routes/usage.js";
import { userRoutes } from "./routes/users.js";
import { ownedBy } from "./scope.js";
import { type ApiAccess, csrfGuard, hostGuard, originGuard } from "./security.js";

export type AppDeps = {
  /** Usuarios y sesiones (F7, ADR-0021): sin sesión, solo las rutas públicas (`access.ts`). */
  auth: AuthDeps;
  /**
   * El usuario del pedido, para la bitácora (spec F7 §4.3): `server.ts` lo compone con
   * `AsyncLocalStorage` (`request-context-node.ts`), que no puede llegar a `AppType`.
   */
  requestContext: RequestContext;
  /** Los `state` del OAuth ya usados: el de Mercado Libre sirve una vez (spec F7 §4.12). */
  oauthStates: OAuthStateRepository;
  checks: Record<HealthCheckName, HealthCheck>;
  publishMode: PublishMode;
  /** El ambiente que informa `/health` (spec F8 §4.2); sin él, no se informa. */
  environment?: "development" | "production";
  version: string;
  logger: AppLogger;
  /** Hosts y orígenes permitidos: `localAccess(API_PORT, WEB_PORT)` o `internetAccess(PUBLIC_URL)`. */
  access: ApiAccess;
  /** Solo para tests; por defecto `DEFAULT_CHECK_TIMEOUT_MS`. */
  checkTimeoutMs?: number;
  /** La versión de la base y el estado del respaldo en `/health` (F6-T14). */
  healthDetails?: HealthDetails;
  // Puertos de core (no los adaptadores): así `AppType` no arrastra drizzle ni el SDK de S3.
  listings: ListingRepository;
  brokers: BrokerRepository;
  media: MediaRepository;
  fieldDefinitions: FieldDefinitionRepository;
  /**
   * Las URLs de lectura temporales de los medios (fotos, renders y reel); desde F7-T14, subir el
   * logo de un corredor, y desde F8 (spec §4.4, ADR-0025) firmar las subidas directas de una carga,
   * revisar que llegaron y borrarlas.
   */
  storage: Pick<MediaStorage, "signedReadUrl" | "put" | "signedUploadUrl" | "list" | "delete">;
  /** El logo de un corredor con sharp (`@agentsales/media/logo`; F7-T14). */
  logos: LogoNormalizer;
  /** sha256 hexadecimal de unos bytes (`node:crypto`, lo compone `server.ts`). */
  sha256Bytes: (bytes: Uint8Array) => string;
  /** La planilla de un corredor (`writeBrokerTemplate` con la plantilla oficial; F7-T14). */
  brokerTemplate: (broker: Broker) => Promise<Uint8Array>;
  // Importación (F1-T11): la API solo crea el run y encola (ADR-0005).
  importRuns: ImportRunRepository;
  queue: JobQueue;
  /** uuid de una carga nueva: se necesita antes de crearla, para sus claves de R2 (spec F8 §4.4). */
  newId: () => string;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo de una carga. */
  maxUploadBytes: number;
  // Contenido (F2-T12): la API pide corridas y edita textos; las corre el worker (ADR-0012).
  contentRuns: ContentRunRepository;
  contents: ContentRepository;
  /**
   * Candado por aviso (ADR-0014, spec F3 §4.2): pedir una corrida y editar corren dentro de él (y,
   * desde T15, aprobar y publicar). `server.ts` compone `createListingLock` sobre la misma base.
   */
  lock: ListingLock;
  /**
   * Posts de marca (F9, ADR-0029): por ahora, el dueño de un recurso de un post (el corredor del
   * post) y lo que necesiten sus rutas (F9-T09 y T10).
   */
  posts: PostRepository;
  /**
   * Candado por post (ADR-0029, punto 3): las rutas de posts escriben dentro de él, con los eventos
   * firmados por el usuario del pedido. `server.ts` compone `createPostLock` sobre la misma base.
   */
  postLock: PostLock;
  /** El perfil editorial de cada corredor o marca (F9-T09): lo lee la IA de los posts. */
  editorialProfiles: EditorialProfileRepository;
  /**
   * Publicaciones (F3-T15): leer las de un aviso y su bitácora, y saber de qué aviso es una antes
   * del candado. Los cambios de estado van dentro del candado, con sus repositorios.
   */
  publications: Pick<
    PublicationRepository,
    "get" | "listByListing" | "listEvents" | "listByStatus" | "listForTracking"
  >;
  // Cuentas (F3-T13): conectar con el token del panel de Meta o por OAuth, y desconectar.
  platformAccounts: PlatformAccountRepository;
  /** Instagram Login, si el OAuth tiene su par de la app, y si la cookie va `Secure`. */
  instagram: OAuthDeps["instagram"];
  /**
   * Mercado Libre (spec F4 §4.2): el OAuth con la dirección pegada, `configured` si está el par de
   * la app (sin él, conectar no llama) y la dirección de retorno que se muestra (`ML_REDIRECT_URI`).
   */
  mercadoLibre: {
    auth: MercadoLibreAuth;
    configured: boolean;
    redirectUri: string;
    /**
     * Con HTTPS (internet), la cookie `__Host-` del `state` y la vuelta automática (spec F8 §4.3,
     * T19); sin él (el Mac), la dirección se sigue pegando.
     */
    secureCookie: boolean;
  };
  /**
   * Pausar, reactivar, cerrar y el sync de Portal (spec F4 §4.9, F4-T19): las operaciones de cada
   * plataforma, **sin envolver** (el modo lo decide la publicación). `server.ts` compone las de
   * Portal con un cliente de ítems de 10 s por llamada (`MERCADOLIBRE_API_TIMEOUT_MS`).
   */
  operationsFor(platform: Platform): PublicationOperations | undefined;
  /** Solo para tests; por defecto `OPERATION_TIMEOUT_MS` (15 s). */
  operationTimeoutMs?: number;
  /**
   * Marketplace (spec F5 §4.6 y §4.7): el límite diario (`MARKETPLACE_DAILY_LIMIT`) y si hay token
   * para convertir la UF (`BCCH_API_TOKEN`). Sin esto, el límite es 3 y la UF no se convierte.
   */
  marketplace?: MarketplaceStartOptions;
  /**
   * Si el ambiente permite el formulario automático de Marketplace (`marketplaceAutomationEnabled`
   * de config: todo menos producción, spec F8 §4.10, D4). En producción, conectar un perfil, pedir
   * su inicio de sesión y publicar con una cuenta de perfil dan `MARKETPLACE_AUTOMATION_NOT_ALLOWED`,
   * y pasar un perfil a mano o desconectarlo no toca el disco.
   */
  marketplaceAutomation: boolean;
  /**
   * Las vueltas de Meta (spec F8 §4.11, D18): la firma del `signed_request` (con `node:crypto`, la
   * compone `server.ts`) y los pedidos de borrado.
   */
  verifyMetaSignature: MetaSignatureVerifier;
  /** El hash con clave del `user_id` de un pedido de borrado (`createMetaUserIdHasher`). */
  hashMetaUserId: (userId: string) => string;
  metaDeletion: MetaDeletionRepository;
  /** Firma del `state` del OAuth (`createStateSigner`, que compone `server.ts`). */
  oauthState: OAuthDeps["oauthState"];
  /** La URL absoluta del panel, adonde vuelve el OAuth. */
  panelUrl: string;
  /**
   * El inicio del OAuth (`/api/oauth/instagram/start`) en el host y la ruta de
   * `INSTAGRAM_REDIRECT_URI`: la cookie del `state` distingue `localhost` de `127.0.0.1`, así que el
   * enlace del panel y la CLI usa ese host (F3-T17); en internet es el mismo del panel (F8).
   */
  instagramStartUrl: string;
  /**
   * El reloj de conectar y refrescar (la ventana de 24 h y 30 días, F3-T14); por defecto la hora
   * actual. Lo fijan los tests.
   */
  now?: () => Date;
  /**
   * Los límites por IP y por usuario (spec F8 §4.8, ADR-0026), con la IP de `CLIENT_IP_HEADER` o
   * del socket. Obligatorio, para no olvidarlo: `null` solo en los tests que no los prueban.
   */
  rateLimit: RateLimitDeps | null;
};

/** Un middleware que no hace nada (un límite que no se configuró). */
const passThrough: MiddlewareHandler<AppEnv> = (_c, next) => next();

/** Arma la API con sus dependencias inyectadas. Las rutas van encadenadas para el cliente `hc`. */
export function createApp(input: AppDeps) {
  // Los eventos de la bitácora escritos por la API llevan el usuario del pedido (spec F7 §4.3).
  const deps: AppDeps = {
    ...input,
    lock: withEventUser(input.lock, input.requestContext),
    postLock: withPostEventUser(input.postLock, input.requestContext),
    // Lo que publicar necesita saber de Marketplace: la configuración y lo que permite el ambiente.
    marketplace: { ...input.marketplace, automation: input.marketplaceAutomation },
  };
  // El refresco del token de Portal, solo con el par de la app (sin él, uno por vencer es
  // `MERCADOLIBRE_NOT_CONFIGURED` sin llamar).
  const publicationDeps = {
    ...deps,
    mercadoLibreRefresh: deps.mercadoLibre.configured ? deps.mercadoLibre.auth : null,
  };
  // Lo que le falta al aviso para Marketplace depende de si se puede convertir la UF (spec F5 §4.6).
  const contentDeps = { ...deps, ufConfigured: deps.marketplace?.ufConfigured ?? false };
  // El corredor dueño de cada recurso por id (spec F7 §4.4): un corredor solo llega a lo suyo.
  const listingOwner = async (id: string) => (await deps.listings.get(id))?.brokerId ?? null;
  // Un post es de su corredor o marca (ADR-0029, punto 12), como un aviso.
  const postOwner = async (id: string) => (await deps.posts.get(id))?.brokerId ?? null;
  const viaSubject = async (subject: Subject | undefined) =>
    subject === undefined
      ? null
      : subject.kind === "listing"
        ? listingOwner(subject.id)
        : postOwner(subject.id);
  const notFound = (code: string, message: string) => (id: string) =>
    new AppError(code, `${message} ${id}`);
  const ownership = {
    listing: ownedBy(listingOwner, notFound("LISTING_NOT_FOUND", "No existe el aviso")),
    post: ownedBy(postOwner, notFound("POST_NOT_FOUND", "No existe el post")),
    contentRun: ownedBy(
      async (id) => viaSubject((await deps.contentRuns.get(id))?.subject),
      notFound("CONTENT_RUN_NOT_FOUND", "No existe la corrida"),
    ),
    content: ownedBy(
      async (id) => viaSubject((await deps.contents.get(id))?.subject),
      notFound("CONTENT_NOT_FOUND", "No existe el texto"),
    ),
    publication: ownedBy(
      async (id) => viaSubject((await deps.publications.get(id))?.subject),
      notFound("PUBLICATION_NOT_FOUND", "No existe la publicación"),
    ),
    importRun: ownedBy(
      async (id) => (await deps.importRuns.get(id))?.brokerId ?? null,
      notFound("IMPORT_RUN_NOT_FOUND", "No existe la carga"),
    ),
    account: ownedBy(
      async (id) => (await deps.platformAccounts.get(id))?.brokerId ?? null,
      notFound("ACCOUNT_NOT_FOUND", "No existe la cuenta"),
    ),
    // El corredor es su propio dueño: un corredor solo llega al suyo (F7-T13).
    broker: ownedBy(async (id) => id, notFound("BROKER_NOT_FOUND", "No existe el corredor")),
  };
  const app = new Hono<AppEnv>()
    .use(requestLogger(deps.logger))
    .use(hostGuard(deps.access.allowedHosts))
    .use(deps.rateLimit === null ? passThrough : rateLimitByIp(deps.rateLimit))
    .use(originGuard(deps.access.allowedOrigins, sessionCookieName(deps.auth.secureCookie)))
    .use(csrfGuard(deps.access.allowedOrigins))
    .use(authenticate(deps.auth, deps.logger, deps.requestContext))
    .use(deps.rateLimit === null ? passThrough : rateLimitByUser(deps.rateLimit))
    // `/x/:id/*` también calza con `/x/:id` en Hono: una sola vez por prefijo (una lectura).
    .use("/listings/:id/*", ownership.listing)
    // Las rutas de posts llegan en F9-T09 y T10; el dueño ya se resuelve por el corredor del post.
    .use("/posts/:id/*", ownership.post)
    .use("/content-runs/:id/*", ownership.contentRun)
    .use("/contents/:id/*", ownership.content)
    .use("/publications/:id/*", ownership.publication)
    // `/imports/uploads` (spec F8 §4.4) también calza con `/imports/:id`: no es una carga.
    .use("/imports/:id/*", (c, next) =>
      c.req.param("id") === "uploads" ? next() : ownership.importRun(c, next),
    )
    .use("/accounts/:id/*", ownership.account)
    .use("/brokers/:id/*", ownership.broker)
    // El chequeo del proveedor (F8-T11): solo que el proceso responde, sin base ni R2. Así una base
    // despertando no saca la API del balanceo de Fly (`/health` puede tardar hasta 25 s).
    .get("/health/live", (c) => c.json({ status: "ok" as const }, 200))
    .get("/health", async (c) => {
      // El detalle solo para el administrador (spec F7 §4.3); los demás, el estado y el modo.
      const admin = c.get("auth")?.user.role === "admin";
      const report = await runHealth({
        checks: deps.checks,
        publishMode: deps.publishMode,
        version: deps.version,
        ...(deps.checkTimeoutMs === undefined ? {} : { timeoutMs: deps.checkTimeoutMs }),
        ...(admin && deps.healthDetails !== undefined ? { details: deps.healthDetails } : {}),
      });
      // Siempre 200: el estado va en el cuerpo (`ok` o `degraded`).
      const environment = deps.environment === undefined ? {} : { environment: deps.environment };
      return c.json(
        admin
          ? { ...report, ...environment }
          : { status: report.status, publishMode: report.publishMode, ...environment },
        200,
      );
    })
    .route("/auth", authRoutes(deps))
    .route("/users", userRoutes(deps))
    // Encadenadas con `.route()`, así `AppType` conserva el esquema de cada ruta (ADR-0011).
    .route("/listings", listingRoutes({ ...deps, statusChange: operationDeps(publicationDeps) }))
    .route("/listings", listingContentRoutes(contentDeps))
    .route("/listings", listingPublicationRoutes(publicationDeps))
    .route("/publications", publicationRoutes(publicationDeps))
    .route("/content-runs", contentRunRoutes(deps))
    .route("/contents", contentRoutes(contentDeps))
    .route("/brokers", brokerRoutes(deps))
    .route("/brokers", editorialProfileRoutes(deps))
    .route("/schedule", scheduleRoutes(publicationDeps))
    .route(
      "/",
      trackingRoutes({
        ...deps,
        ...(deps.healthDetails?.backupStatus === undefined
          ? {}
          : { backupStatus: deps.healthDetails.backupStatus }),
      }),
    )
    .route("/usage", usageRoutes(deps))
    .route("/imports", importRoutes(deps))
    .route(
      "/accounts",
      accountRoutes({
        ...deps,
        stateHash: (nonce) => deps.auth.tokens.hash(nonce),
        instagram: deps.instagram.auth,
        instagramOAuth: deps.instagram.oauthConfigured && deps.instagram.secureCookie,
      }),
    )
    .route("/oauth", oauthRoutes({ ...deps, stateHash: (nonce) => deps.auth.tokens.hash(nonce) }))
    .route("/meta", metaRoutes(deps));
  app.onError(createErrorHandler(deps.logger));
  app.notFound(notFoundHandler);
  return app;
}

/** Tipo de la API para el cliente RPC (`hc<AppType>`) de la CLI y el panel. */
export type AppType = ReturnType<typeof createApp>;

/**
 * La app montada bajo `/api` (spec F8 §4.3, ADR-0024), como la sirve `server.ts` en los dos modos:
 * el panel llama a `/api/...` (por Vite en el Mac, del mismo origen en el servidor) y la CLI a
 * `<dirección>/api/...`. `AppType` no cambia: el cliente `hc` recibe la dirección con el prefijo.
 * Un `/api/x` que no existe responde el 404 JSON de la app.
 */
export function mountApi(app: AppType) {
  const root = new Hono().route(API_PREFIX, app);
  root.notFound(notFoundHandler);
  return root;
}
