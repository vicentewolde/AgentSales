// Dobles de la API para tests (`@agentsales/api/testing`): `AppDeps` con repositorios en memoria,
// para probar contra `createApp` sin red ni base (los tests de la API y de la CLI).
// Solo para tests: Biome prohíbe importarlo desde código de aplicación.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createStateSigner, type Logger } from "@agentsales/config";
import { AppError, type InstagramAuth } from "@agentsales/core";
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
    oauthState: createStateSigner(TEST_ENCRYPTION_KEY),
    panelUrl: "http://localhost:5173",
    instagramStartUrl: "http://localhost:8787/oauth/instagram/start",
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
