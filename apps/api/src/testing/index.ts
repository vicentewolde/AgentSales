// Dobles de la API para tests (`@agentsales/api/testing`): `AppDeps` con repositorios en memoria,
// para probar contra `createApp` sin red ni base (los tests de la API y de la CLI).
// Solo para tests: Biome prohíbe importarlo desde código de aplicación.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createStateSigner, type Logger } from "@agentsales/config";
import { AppError, type InstagramAuth, type MercadoLibreAuth } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryImportRunRepository,
  createInMemoryJobQueue,
  createInMemoryListingLock,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import type { AppDeps } from "../app.js";

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

/** Archivos "guardados" por la API en un test: `runId → nombre → bytes`. */
export type FakeUploads = AppDeps["uploads"] & { files: Map<string, Map<string, Uint8Array>> };

export function fakeUploads(): FakeUploads {
  const files = new Map<string, Map<string, Uint8Array>>();
  return {
    files,
    async save(runId, fileName, body) {
      const run = files.get(runId) ?? new Map<string, Uint8Array>();
      run.set(fileName, new Uint8Array(await new Response(body).arrayBuffer()));
      files.set(runId, run);
      return `/workspace/tmp/imports/${runId}/input/${fileName}`;
    },
    async discard(runId) {
      files.delete(runId);
    },
  };
}

/**
 * Dependencias de la app con dobles en memoria (ids uuid, como en Postgres). `app.request("/x")`
 * usa http://localhost/x: el Host es "localhost", y el origen del panel, el 5173.
 */
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const content = createInMemoryContentRepositories({ nextId: randomUUID });
  // La app solo lee las publicaciones; el candado las cambia. Un test que trae las suyas trae
  // también su candado (como el escenario de publicación), para que los dos vean las mismas.
  if (overrides.publications !== undefined && overrides.lock === undefined) {
    throw new Error("testDeps: con publications, pasa también lock (el que las cambia)");
  }
  const publications = createInMemoryPublicationRepository();
  const deps: Omit<AppDeps, "lock"> & { lock?: AppDeps["lock"] } = {
    checks: { db: ok, storage: ok, queue: ok },
    publishMode: "dry-run",
    version: "0.0.1",
    logger: silentLogger,
    access: { allowedHosts: ["localhost"], allowedOrigins: ["http://localhost:5173"] },
    listings: createInMemoryListingRepository({ nextId: randomUUID }),
    brokers: createInMemoryBrokerRepository(),
    media: createInMemoryMediaRepository(),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(),
    storage: { signedReadUrl: async (path) => `https://r2.test/${path}?firma` },
    importRuns: createInMemoryImportRunRepository({ nextId: randomUUID }),
    queue: createInMemoryJobQueue(),
    uploads: fakeUploads(),
    newId: randomUUID,
    localImports: true,
    maxUploadBytes: 50 * 1024 * 1024,
    contentRuns: content.contentRuns,
    contents: content.contents,
    platformAccounts: createInMemoryPlatformAccountRepository({ nextId: randomUUID }),
    publications,
    instagram: { auth: fakeInstagramAuth(), oauthConfigured: true, secureCookie: false },
    mercadoLibre: {
      auth: fakeMercadoLibreAuth(),
      configured: true,
      redirectUri: TEST_ML_REDIRECT_URI,
    },
    oauthState: createStateSigner(TEST_ENCRYPTION_KEY),
    panelUrl: "http://localhost:5173",
    instagramStartUrl: "http://localhost:8787/oauth/instagram/start",
    // Sin operaciones: los tests de Portal pasan las suyas (nunca llaman a Mercado Libre).
    operationsFor: () => undefined,
    ...overrides,
  };
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
  return { ...deps, lock };
}
