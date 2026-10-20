import { createHash, randomUUID } from "node:crypto";
import { type AppDeps, createApp, localAccess } from "@agentsales/api";
import { testAuth, testDeps, testStorage, withAdminSession } from "@agentsales/api/testing";
import {
  ALL_SCOPE,
  type BrokerData,
  type FieldDefinition,
  type LLMProvider,
  listingSubject,
  type NewListing,
  type PublicationOperations,
  prepareContent,
  SAMPLE_CONTENT_DRAFT,
} from "@agentsales/core";
import {
  contentDefinitionsFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryHtmlRenderer,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemoryPlatformAccountRepository,
  createInMemorySlideTemplates,
  createPublicationScenario,
  fakeHash,
} from "@agentsales/core/testing";
import { QueryClient } from "@tanstack/react-query";
import { configure, render, screen } from "@testing-library/react";
import { App } from "../src/App.js";
import { createApiClient } from "../src/api/client.js";
import type { UploadDeps, UploadTransport } from "../src/api/upload.js";

// `findBy…` y `waitFor` esperan hasta 4 s (1 s por defecto): con la máquina o la CI cargadas, una
// página diferida o la API en proceso pueden tardar más de 1 s. Queda bajo el timeout de cada test
// (5 s), para que una espera fallida muestre el mensaje de Testing Library.
configure({ asyncUtilTimeout: 4_000 });

/** Un `PUT` del panel a R2 (el doble): qué archivo y con qué cabeceras firmadas. */
export type Transfer = { name: string; size: number; headers: Record<string, string> };

export type HarnessOptions = {
  deps?: Partial<AppDeps>;
  /**
   * Responde en lugar de la API (devolver `undefined` deja pasar la petición). Lanzar simula una
   * falla de red; una promesa que no termina, una API colgada.
   */
  intercept?: (
    method: string,
    path: string,
    init?: RequestInit,
  ) => Promise<Response> | Response | undefined;
  /**
   * `none`: sin la sesión del administrador por defecto (F7-T07), con las cookies que la API pone
   * guardadas y devueltas como lo haría el navegador (probar entrar, la invitación y salir).
   */
  session?: "admin" | "none";
  /** El `PUT` a R2 (por defecto, el doble en memoria de la API): para simular fallos o esperas. */
  transport?: (memory: UploadTransport) => UploadTransport;
};

/**
 * La API real en proceso (`createApp` con repositorios en memoria) detrás del cliente del panel,
 * sin red: el pedido llega a `createApp` sin el prefijo `/api` (el servidor la monta con `mountApi`,
 * spec F8 §4.3; aquí, como la tabla de permisos, la app se usa sin montar).
 */
export function harness(options: HarnessOptions = {}) {
  const listings = createInMemoryListingRepository({ nextId: randomUUID });
  // Ids uuid, como Postgres: `/brokers/:id` los exige (F7-T18).
  const brokers = createInMemoryBrokerRepository([], { nextId: randomUUID });
  const media = createInMemoryMediaRepository();
  const importRuns = createInMemoryImportRunRepository({ nextId: randomUUID });
  // El gasto de IA por corredor (F7-T12) cruza la corrida con su aviso, como Postgres.
  const content = createInMemoryContentRepositories({
    nextId: randomUUID,
    brokerOfListing: async (id) => (await listings.get(id))?.brokerId ?? null,
  });
  const platformAccounts = createInMemoryPlatformAccountRepository({ nextId: randomUUID });
  // R2 en memoria (spec F8 §4.4): la API firma las subidas y el panel "sube" aquí.
  const storage = testStorage();
  const auth = { ...testAuth(), brokers: options.deps?.brokers ?? brokers };
  const deps = testDeps({
    auth,
    access: localAccess(8787, 5173),
    listings,
    brokers,
    media,
    importRuns,
    contentRuns: content.contentRuns,
    contents: content.contents,
    platformAccounts,
    storage,
    ...options.deps,
  });
  const base = createApp(deps);
  const anonymous = options.session === "none";
  const app = anonymous ? base : withAdminSession(base);
  // Sin sesión por defecto, la cookie de sesión se guarda y se devuelve como en el navegador.
  let cookie: string | null = null;
  const remember = (response: Response): Response => {
    const set = response.headers.get("set-cookie");
    if (anonymous && set !== null)
      cookie = /Max-Age=0/i.test(set) ? null : (set.split(";")[0] ?? null);
    return response;
  };
  let brokerToken: string | null = null;
  /** Entra como el usuario de un corredor (F7-T17): el panel lo ve con su rol y su alcance. */
  const signInAsBroker = (brokerId: string) => {
    const token = `token-del-corredor-${brokerId}`;
    const user = auth.repos.seed.user({
      email: `corredor-${brokerId.slice(0, 8)}@ejemplo.cl`,
      name: "Corredor de prueba",
      role: "broker",
      brokerId,
    });
    auth.repos.seed.session({
      userId: user.id,
      tokenHash: auth.tokens.hash(token),
      client: "panel",
    });
    brokerToken = token;
    return user;
  };
  const requests: string[] = [];
  /** Lo que el panel subió a R2 (el doble), en orden. */
  const transfers: Transfer[] = [];
  const client = createApiClient("/api", {
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost:5173",
      );
      const path = url.pathname.replace(/^\/api/, "") + url.search;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      const intercepted = options.intercept?.(method, path, init);
      if (intercepted !== undefined) return intercepted;
      // El navegador manda `Origin` en un POST: sin él, `csrf()` rechaza el pedido.
      const headers = new Headers(init?.headers);
      if (method !== "GET") headers.set("origin", "http://localhost:5173");
      if (cookie !== null) headers.set("cookie", cookie);
      // La sesión de un corredor (F7-T17): con ella, la API no pone la del administrador.
      if (brokerToken !== null) headers.set("authorization", `Bearer ${brokerToken}`);
      return remember(await app.request(`http://localhost:5173${path}`, { ...init, headers }));
    },
  });

  /**
   * El `PUT` a R2 con el doble en memoria: entrega los bytes a `receiveUpload`, que exige las
   * cabeceras firmadas, el largo y el sha256 (spec F8 §4.4). El avance llega en dos pasos.
   */
  const memoryTransport: UploadTransport = async ({ url, headers, body, signal, onProgress }) => {
    if (signal.aborted) throw new DOMException("Subida cancelada", "AbortError");
    const bytes = new Uint8Array(await body.arrayBuffer());
    onProgress(Math.floor(bytes.byteLength / 2));
    await storage.receiveUpload(url, headers, bytes);
    onProgress(bytes.byteLength);
    transfers.push({ name: url.split("?")[0] ?? url, size: bytes.byteLength, headers });
  };
  const upload: UploadDeps = {
    transport: options.transport?.(memoryTransport) ?? memoryTransport,
    // jsdom no tiene Web Crypto (`crypto.subtle`): el sha256 sale de Node.
    hash: async (blob) =>
      createHash("sha256")
        .update(new Uint8Array(await blob.arrayBuffer()))
        .digest("hex"),
  };

  /** La caché del panel (para revisar que un secreto no quede en ella, F7-T18). */
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderApp = (initialPath = "/"): void => {
    render(
      <App
        client={client}
        queryClient={queryClient}
        inMemory
        initialPath={initialPath}
        upload={upload}
      />,
    );
  };

  return {
    client,
    /** Todas las dependencias de la API (los posts, su candado y sus publicaciones: F9-T17). */
    deps,
    /** La autenticación de la API (los dobles de core, con el administrador sembrado). */
    auth,
    requests,
    transfers,
    storage,
    listings,
    brokers,
    media,
    importRuns,
    contentRuns: content.contentRuns,
    contents: content.contents,
    platformAccounts,
    renderApp,
    signInAsBroker,
    queryClient,
  };
}

/**
 * Un aviso listo con sus fotos (y un video si se pide) para preparar su contenido, y `prepare`, que
 * hace de worker: corre `prepareContent` (core) con dobles sobre la corrida más reciente.
 */
export async function contentSetup(
  h: ReturnType<typeof harness>,
  options: { video?: boolean; internalNotes?: string } = {},
) {
  const storage = createInMemoryMediaStorage();
  const broker = await h.brokers.create({ ...brokerData("marca"), whatsapp: "+56911112222" });
  const listing = await h.listings.create(
    newListing(broker.id, "P-001", {
      attributes: { dormitorios: 3, banos: 2, sup_util_m2: 72 },
      internalNotes: options.internalNotes ?? null,
    }),
  );
  await h.listings.promoteToReady(listing.id);
  const names = ["foto-1.jpg", "foto-2.jpg", "foto-3.jpg", ...(options.video ? ["video.mp4"] : [])];
  for (const [index, name] of names.entries()) {
    const kind = name.endsWith(".mp4") ? ("video" as const) : ("image" as const);
    const mime = kind === "video" ? "video/mp4" : "image/jpeg";
    const path = `brokers/${broker.id}/listings/${listing.id}/original/${name}`;
    await storage.put(path, new TextEncoder().encode(name), mime);
    await h.media.create({
      listingId: listing.id,
      brokerId: broker.id,
      kind,
      storagePath: path,
      mime,
      bytes: name.length,
      checksum: `sha-${name}`,
      sortOrder: index,
      isCover: index === 0,
    });
  }
  const fieldDefinitions = createInMemoryFieldDefinitionRepository(contentDefinitionsFixture());
  const prepare = async (
    llm: LLMProvider = createInMemoryLlmProvider([{ data: SAMPLE_CONTENT_DRAFT }]),
  ) => {
    const run = await h.contentRuns.latest(listingSubject(listing.id));
    if (run === null) throw new Error("no hay corridas");
    return prepareContent(
      {
        contentRuns: h.contentRuns,
        listings: h.listings,
        brokers: h.brokers,
        fieldDefinitions,
        media: h.media,
        storage,
        processor: createInMemoryMediaProcessor(),
        templates: createInMemorySlideTemplates(),
        renderer: createInMemoryHtmlRenderer(),
        llm,
        sha256: fakeHash,
      },
      { contentRunId: run.id, isLastAttempt: true },
    );
  };
  return { listing, broker, fieldDefinitions, prepare };
}

/**
 * Un aviso preparado con la cuenta de Instagram conectada (el escenario de publicación de core, con
 * ids uuid) y el panel sobre la API en proceso (F3-T18). Los repositorios del escenario están en
 * `t`; `open` abre el detalle y devuelve la sección Contenido.
 */
export async function publicationSetup(
  options: {
    approve?: boolean;
    publishMode?: "dry-run" | "live";
    intercept?: HarnessOptions["intercept"];
    /** Portal (F4-T22) o Marketplace (F5-T13): la cuenta y el texto aprobado son de ese canal. */
    platform?: "instagram" | "portal_inmobiliario" | "fb_marketplace";
    /** Marketplace: si la API tiene el token de la UF (por defecto, sí). */
    ufConfigured?: boolean;
    /** Las operaciones de Portal que usa la API (dobles: nunca Mercado Libre). */
    operations?: PublicationOperations;
  } = {},
) {
  const t = await createPublicationScenario({
    nextId: randomUUID,
    approve: options.approve ?? true,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const operations = options.operations;
  const h = harness({
    deps: {
      listings: t.listings,
      brokers: t.brokers,
      media: t.media,
      fieldDefinitions: t.fieldDefinitions,
      storage: t.storage,
      contents: t.contents,
      contentRuns: t.contentRuns,
      platformAccounts: t.platformAccounts,
      publications: t.publications,
      lock: t.deps.lock,
      queue: t.deps.queue,
      publishMode: options.publishMode ?? "dry-run",
      operationsFor: (platform) => (platform === "portal_inmobiliario" ? operations : undefined),
      marketplace: { dailyLimit: 3, ufConfigured: options.ufConfigured ?? true },
      // Como `server.ts`: `/health` informa los corredores con `auto_publish` (F6-T13).
      healthDetails: {
        autoPublishBrokers: async () =>
          (await t.brokers.list(ALL_SCOPE))
            .filter((broker) => broker.autoPublish)
            .map((b) => b.slug),
      },
    },
    ...(options.intercept === undefined ? {} : { intercept: options.intercept }),
  });
  const open = async () => {
    h.renderApp(`/propiedades/${t.listingId}`);
    return screen.findByRole("region", { name: "Contenido" });
  };
  // Solo lo que usa la API: los repositorios del arnés no son los del escenario (están en `t`).
  return { client: h.client, requests: h.requests, renderApp: h.renderApp, t, open };
}

/** Corredor sintético (datos inventados). */
export const brokerData = (slug: string): BrokerData => ({
  slug,
  name: "Persona Inventada",
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

/** Aviso sintético (datos inventados). */
export const newListing = (
  brokerId: string,
  externalRef: string,
  extra: Partial<NewListing> = {},
): NewListing => ({
  brokerId,
  externalRef,
  category: "real_estate",
  source: "xlsx",
  operation: "sale",
  propertyType: "Departamento",
  region: "Metropolitana",
  comuna: "Ñuñoa",
  address: "Calle Inventada 123",
  unitNumber: null,
  showExactAddress: false,
  priceAmount: 5800,
  priceCurrency: "UF",
  highlights: null,
  internalNotes: null,
  attributes: { dormitorios: 3 },
  sourceHash: "hash",
  ...extra,
});

/** Definición global sintética. */
export const definition = (key: string, label: string, sortOrder: number): FieldDefinition => ({
  id: randomUUID(),
  brokerId: null,
  category: "real_estate",
  key,
  label,
  type: "text",
  required: false,
  options: null,
  sourceColumn: key,
  isCore: false,
  minValue: null,
  maxValue: null,
  sortOrder,
  active: true,
});

export { createInMemoryFieldDefinitionRepository };
