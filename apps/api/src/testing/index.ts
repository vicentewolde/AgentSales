// Dobles de la API para tests (`@agentsales/api/testing`): `AppDeps` con repositorios en memoria,
// para probar contra `createApp` sin red ni base (los tests de la API y de la CLI).
// Solo para tests: Biome prohíbe importarlo desde código de aplicación.
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createStateSigner, type Logger } from "@agentsales/config";
import {
  AppError,
  type InstagramAuth,
  type MercadoLibreAuth,
  type SessionClient,
} from "@agentsales/core";
import {
  createFakePasswordHasher,
  createFakeSecretBox,
  createFakeSecretTokens,
  createFakeTotpProvider,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryEditorialProfileRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryMetaDeletionRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostLock,
  createInMemoryPostRepository,
  createInMemoryPostUploadRepository,
  createInMemoryPublicationRepository,
  createInMemoryUserRepositories,
  type InMemoryMediaStorage,
  type InMemoryUserRepositories,
} from "@agentsales/core/testing";
import { type AppDeps, createApp } from "../app.js";
import type { AuthDeps } from "../auth.js";
import { createRequestContext } from "../request-context-node.js";

/** Clave de prueba para el `state` del OAuth (nunca la de `.env`). */
export const TEST_ENCRYPTION_KEY = "clave-de-prueba-de-32-caracteres-o-mas-0123456789";

/**
 * Instagram falso para la API: canjea un código conocido, responde `/me` por token, refresca y
 * registra las llamadas. Un código o token que empiece con `malo` es `IG_AUTH_INVALID`, y refrescar
 * uno que empiece con `caido`, `IG_UNAVAILABLE`.
 */
export function fakeInstagramAuth(): InstagramAuth & { calls: string[] } {
  const calls: string[] = [];
  const reject = () =>
    new AppError(
      "IG_AUTH_INVALID",
      "El acceso a Instagram venció o ya no es válido: reconecta la cuenta",
    );
  return {
    calls,
    authorizeUrl: (state) =>
      `https://www.instagram.com/oauth/authorize?client_id=app&state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      calls.push("exchange");
      if (code.startsWith("malo")) throw reject();
      return {
        accessToken: `IGAA-largo-${code}`,
        expiresAt: new Date("2026-12-05T12:00:00Z"),
        permissions: code.includes("sin-publicar")
          ? ["instagram_business_basic"]
          : ["instagram_business_basic", "instagram_business_content_publish"],
      };
    },
    async refresh(accessToken) {
      calls.push("refresh");
      if (accessToken.startsWith("malo")) throw reject();
      if (accessToken.startsWith("caido")) {
        throw new AppError("IG_UNAVAILABLE", "Instagram no responde: intenta más tarde", {
          retriable: true,
        });
      }
      return {
        accessToken: `${accessToken}-refrescado`,
        expiresAt: new Date("2026-12-05T12:00:00Z"),
      };
    },
    async me(accessToken) {
      calls.push("me");
      if (accessToken.startsWith("malo")) throw reject();
      return { userId: "17841400000000001", username: "corredora", accountType: "BUSINESS" };
    },
  };
}

/** La dirección de retorno de Mercado Libre de los tests (la de `.env.example`). */
export const TEST_ML_REDIRECT_URI = "https://agentsales.test/oauth/mercadolibre/callback";

/**
 * Mercado Libre falso para la API (spec F4 §4.2): canjea un código y responde `/users/me`, y
 * registra las llamadas (sin valores). El código decide el caso: `malo…` es `ML_AUTH_INVALID`,
 * `rechazado…` es `ML_REQUEST_REJECTED`, `sin-offline…` y `sin-write…` no traen ese permiso,
 * `sin-refresh…` no trae `refresh_token`, `otro-usuario…` responde otro `user_id` en `/users/me`,
 * `otra-cuenta…` es otra cuenta del vendedor (`user_id` 777) y `argentina…` es una cuenta de `MLA`.
 * El refresco (F4-T08) entrega un par nuevo (`…-refrescado-<n>`), salvo que el `refresh_token` lleve
 * `vence` (`invalid_grant`) o `caida` (`ML_UNAVAILABLE`).
 * Los tokens llevan el código, para que un test revise que no aparecen en la respuesta ni el log.
 */
export function fakeMercadoLibreAuth(): MercadoLibreAuth & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorizeUrl: (state) =>
      `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=app&redirect_uri=${encodeURIComponent(TEST_ML_REDIRECT_URI)}&state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      calls.push("exchange");
      if (code.startsWith("malo")) {
        throw new AppError(
          "ML_AUTH_INVALID",
          "Mercado Libre no aceptó el código de conexión: conecta de nuevo",
          { details: { httpStatus: 400, error: "invalid_grant", causes: [] } },
        );
      }
      if (code.startsWith("rechazado")) {
        throw new AppError(
          "ML_REQUEST_REJECTED",
          "Mercado Libre rechazó la petición (invalid_request)",
          { details: { httpStatus: 400, error: "invalid_request", causes: [] } },
        );
      }
      const scopes = ["offline_access", "read", "write"].filter(
        (scope) =>
          !(code.startsWith("sin-offline") && scope === "offline_access") &&
          !(code.startsWith("sin-write") && scope === "write"),
      );
      return {
        accessToken: `APP_USR-fake-${code}`,
        refreshToken: code.startsWith("sin-refresh") ? null : `TG-fake-${code}`,
        accessTokenExpiresAt: new Date("2026-10-07T18:00:00Z"),
        scopes,
        userId: code.startsWith("otra-cuenta") ? "777" : "8035443",
      };
    },
    async refresh(refreshToken) {
      calls.push("refresh");
      if (refreshToken.includes("vence")) {
        throw new AppError(
          "ML_AUTH_INVALID",
          "Mercado Libre ya no acepta el acceso de la cuenta: reconéctala",
          { details: { httpStatus: 400, error: "invalid_grant", causes: [] } },
        );
      }
      if (refreshToken.includes("caida")) {
        throw new AppError("ML_UNAVAILABLE", "No hubo conexión con Mercado Libre: se reintenta", {
          retriable: true,
        });
      }
      const n = calls.filter((call) => call === "refresh").length;
      return {
        accessToken: `APP_USR-fake-refrescado-${n}`,
        refreshToken: `TG-fake-refrescado-${n}`,
        accessTokenExpiresAt: new Date("2026-10-08T18:00:00Z"),
        scopes: ["offline_access", "read", "write"],
        userId: "8035443",
      };
    },
    async me(accessToken) {
      calls.push("me");
      const other = accessToken.includes("otra-cuenta");
      return {
        userId: accessToken.includes("otro-usuario") ? "999" : other ? "777" : "8035443",
        nickname: other ? "OTRA_CUENTA" : "CORREDORA_PRUEBA",
        siteId: accessToken.includes("argentina") ? "MLA" : "MLC",
        userType: "normal",
        tags: ["normal"],
      };
    },
  };
}

export const silentLogger: Logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);

const ok = async () => {};

/**
 * R2 en memoria para la API (spec F8 §4.4): firma las subidas y, con `receiveUpload`, hace de R2
 * ante el `PUT` del panel o la CLI (verifica el sha256 con `node:crypto`). Las URLs de lectura
 * son las de siempre en los tests (`https://r2.test/<ruta>?firma`).
 */
export function testStorage(): InMemoryMediaStorage {
  const storage = createInMemoryMediaStorage({
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  });
  storage.signedReadUrl = async (path) => `https://r2.test/${path}?firma`;
  return storage;
}

/** El token de la sesión de administrador del panel que siembra `testDeps` (F7-T04). */
export const TEST_ADMIN_TOKEN = "token-admin-de-prueba";
/** El de su sesión de la CLI (la bitácora registra `actor: cli`, F7-T10). */
export const TEST_ADMIN_CLI_TOKEN = "token-admin-cli-de-prueba";
/** El administrador sembrado (su correo y su contraseña, con el hash falso de core). */
export const TEST_ADMIN = {
  id: "00000000-0000-4000-8000-00000000a001",
  email: "admin@ejemplo.cl",
  password: "clave-del-admin-de-prueba",
} as const;

/** La autenticación de los tests: los dobles de core con el administrador y su sesión. */
export type TestAuth = AuthDeps & { repos: InMemoryUserRepositories };

export function testAuth(): TestAuth {
  const repos = createInMemoryUserRepositories({ nextId: randomUUID });
  const hasher = createFakePasswordHasher();
  const tokens = createFakeSecretTokens();
  const admin = repos.seed.user({
    id: TEST_ADMIN.id,
    email: TEST_ADMIN.email,
    name: "Admin de prueba",
    role: "admin",
    brokerId: null,
    passwordHash: `fake:${TEST_ADMIN.password}`,
  });
  // Dos sesiones del administrador: la del panel (`TEST_ADMIN_TOKEN`) y la de la CLI; T10 saca de
  // ahí el canal de la bitácora (`operator` o `cli`).
  repos.seed.session({
    userId: admin.id,
    tokenHash: tokens.hash(TEST_ADMIN_TOKEN),
    client: "panel",
  });
  repos.seed.session({
    userId: admin.id,
    tokenHash: tokens.hash(TEST_ADMIN_CLI_TOKEN),
    client: "cli",
  });
  return {
    repos,
    users: repos.users,
    sessions: repos.sessions,
    invitations: repos.invitations,
    brokers: createInMemoryBrokerRepository(),
    hasher,
    tokens,
    loginChallenges: repos.loginChallenges,
    totp: createFakeTotpProvider(),
    totpBox: createFakeSecretBox(),
    secureCookie: false,
  };
}

/** Cualquier app de Hono con `request`: la de `createApp` o la montada bajo `/api` (`mountApi`). */
type RequestableApp = { request: ReturnType<typeof createApp>["request"] };

/**
 * La app con la sesión del administrador sembrado en cada pedido que no traiga la suya
 * (`Authorization` o cookie): así los tests de antes de F7 siguen igual (spec F7-T04). Para probar
 * sin sesión, usa `createApp` directo. Solo envuelve `app.request` (no `app.fetch`): los arneses
 * pasan por `request`.
 */
export function withAdminSession<A extends RequestableApp>(
  app: A,
  options: { client?: SessionClient } = {},
): A {
  const token = options.client === "cli" ? TEST_ADMIN_CLI_TOKEN : TEST_ADMIN_TOKEN;
  const withAuth = (init: RequestInit | undefined): RequestInit => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization") && !headers.has("cookie")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return { ...init, headers };
  };
  const request = app.request.bind(app);
  app.request = ((input: string | URL | Request, init?: RequestInit, ...rest: unknown[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: la firma de `request` de Hono, sin cambios
    (request as any)(input, withAuth(init), ...rest)) as A["request"];
  return app;
}

/** `createApp` con la sesión del administrador (`withAdminSession`). */
export const adminApp = (deps: AppDeps) => withAdminSession(createApp(deps));

/**
 * Dependencias de la app con dobles en memoria (ids uuid, como en Postgres). `app.request("/x")`
 * usa http://localhost/x: el Host es "localhost", y el origen del panel, el 5173.
 */
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  // El gasto de IA por corredor (F7-T12) cruza la corrida con el aviso (o, desde F9, con el
  // post), como Postgres.
  let listingsRef: AppDeps["listings"] | undefined;
  const posts = overrides.posts ?? createInMemoryPostRepository();
  const content = createInMemoryContentRepositories({
    nextId: randomUUID,
    brokerOfListing: async (id) => (await listingsRef?.get(id))?.brokerId ?? null,
    brokerOfPost: async (id) => (await posts.get(id))?.brokerId ?? null,
  });
  // La app solo lee las publicaciones; el candado las cambia. Un test que trae las suyas trae
  // también su candado (como el escenario de publicación), para que los dos vean las mismas.
  if (overrides.publications !== undefined && overrides.lock === undefined) {
    throw new Error("testDeps: con publications, pasa también lock (el que las cambia)");
  }
  const publications = createInMemoryPublicationRepository();
  const brokers = overrides.brokers ?? createInMemoryBrokerRepository([], { nextId: randomUUID });
  const deps: Omit<AppDeps, "lock" | "postLock"> & {
    lock?: AppDeps["lock"];
    postLock?: AppDeps["postLock"];
  } = {
    // La autenticación ve los mismos corredores que la app (`/auth/me`).
    auth: { ...testAuth(), brokers },
    oauthStates: createInMemoryUserRepositories().oauthStates,
    requestContext: createRequestContext(),
    checks: { db: ok, storage: ok, queue: ok },
    publishMode: "dry-run",
    version: "0.0.1",
    logger: silentLogger,
    access: { allowedHosts: ["localhost"], allowedOrigins: ["http://localhost:5173"] },
    listings: createInMemoryListingRepository({ nextId: randomUUID }),
    brokers,
    media: createInMemoryMediaRepository(),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(),
    storage: testStorage(),
    // El logo y la planilla con dobles: sus pruebas de verdad van en `packages/media` e importers.
    logos: {
      normalize: async (input) => {
        if (input[0] !== 0x89) throw new AppError("LOGO_INVALID", "El logo debe ser PNG");
        return { bytes: input, width: 1, height: 1 };
      },
    },
    sha256Bytes: (bytes) => `sha-${bytes.byteLength}`,
    brokerTemplate: async (broker) => new TextEncoder().encode(`planilla de ${broker.slug}`),
    importRuns: createInMemoryImportRunRepository({ nextId: randomUUID }),
    queue: createInMemoryJobQueue(),
    newId: randomUUID,
    maxUploadBytes: 50 * 1024 * 1024,
    contentRuns: content.contentRuns,
    contents: content.contents,
    posts,
    editorialProfiles: createInMemoryEditorialProfileRepository(),
    platformAccounts: createInMemoryPlatformAccountRepository({ nextId: randomUUID }),
    publications,
    instagram: { auth: fakeInstagramAuth(), oauthConfigured: true, secureCookie: false },
    mercadoLibre: {
      auth: fakeMercadoLibreAuth(),
      configured: true,
      redirectUri: TEST_ML_REDIRECT_URI,
      secureCookie: false,
    },
    oauthState: createStateSigner(TEST_ENCRYPTION_KEY),
    // Sin firma válida ni cuentas: los tests de Meta pasan las suyas (`meta.test.ts`).
    verifyMetaSignature: () => null,
    hashMetaUserId: (userId) => `hmac:${userId}`,
    metaDeletion: createInMemoryMetaDeletionRepository({
      platformAccounts: createInMemoryPlatformAccountRepository(),
      publications: createInMemoryPublicationRepository(),
    }),
    panelUrl: "http://localhost:5173",
    instagramStartUrl: "http://localhost:8787/api/oauth/instagram/start",
    // Sin operaciones: los tests de Portal pasan las suyas (nunca llaman a Mercado Libre).
    operationsFor: () => undefined,
    // Como en desarrollo: el formulario automático corre (los tests de producción pasan `false`).
    marketplaceAutomation: true,
    // Sin límites por IP: los prueba `rate-limit.test.ts` con los suyos.
    rateLimit: null,
    ...overrides,
  };
  listingsRef = deps.listings;
  // El candado entrega los mismos repositorios que la app (también los que pisó `overrides`).
  const lock =
    deps.lock ??
    createInMemoryListingLock({
      brokers: deps.brokers,
      listings: deps.listings,
      media: deps.media,
      contentRuns: deps.contentRuns,
      contents: deps.contents,
      // Los mismos repositorios de publicaciones y cuentas que la app (spec F3-T13 y T15).
      publications,
      platformAccounts: deps.platformAccounts,
    });
  // El candado del post, con los mismos repositorios (F9).
  const postLock =
    deps.postLock ??
    createInMemoryPostLock({
      brokers: deps.brokers,
      posts: deps.posts,
      postUploads: createInMemoryPostUploadRepository(),
      media: deps.media,
      contentRuns: deps.contentRuns,
      contents: deps.contents,
      publications,
      platformAccounts: deps.platformAccounts,
    });
  return { ...deps, lock, postLock };
}
