import { randomUUID } from "node:crypto";
import { type AppDeps, createApp, localAccess } from "@agentsales/api";
import { testAuth, testDeps, withAdminSession } from "@agentsales/api/testing";
import {
  ALL_SCOPE,
  type BrokerData,
  type FieldDefinition,
  type LLMProvider,
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

// `findBy…` y `waitFor` esperan hasta 4 s (1 s por defecto): con la máquina o la CI cargadas, una
// página diferida o la API en proceso pueden tardar más de 1 s. Queda bajo el timeout de cada test
// (5 s), para que una espera fallida muestre el mensaje de Testing Library.
configure({ asyncUtilTimeout: 4_000 });

export type UploadedForm = {
  file: { name: string; size: number } | null;
  media: { name: string; size: number } | null;
  broker: string | null;
  dryRun: string | null;
};

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
};

/**
 * La API real en proceso (`createApp` con repositorios en memoria) detrás del cliente del panel,
 * sin red: el proxy de Vite (`/api` → API) se imita quitando el prefijo (spec F1-T13).
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
  const auth = { ...testAuth(), brokers: options.deps?.brokers ?? brokers };
  const base = createApp(
    testDeps({
      auth,
      access: localAccess(8787, 5173),
      listings,
      brokers,
      media,
      importRuns,
      contentRuns: content.contentRuns,
      contents: content.contents,
      platformAccounts,
      ...options.deps,
    }),
  );
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
  /** Lo que el panel mandó en cada `POST /imports` (multipart). */
  const uploads: UploadedForm[] = [];
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
      // El navegador manda `Origin` en un POST: sin él, `csrf()` rechaza el multipart.
      const headers = new Headers(init?.headers);
      if (method !== "GET") headers.set("origin", "http://localhost:5173");
      if (cookie !== null) headers.set("cookie", cookie);
      // La sesión de un corredor (F7-T17): con ella, la API no pone la del administrador.
      if (brokerToken !== null) headers.set("authorization", `Bearer ${brokerToken}`);
      if (method === "POST" && path === "/imports" && init?.body instanceof FormData) {
        return forwardUpload(init.body, headers);
      }
      return remember(await app.request(`http://localhost:5173${path}`, { ...init, headers }));
    },
  });

  /**
   * jsdom no puede pasarle a la API un `FormData` con archivos (su `File` no es el de Node), así
   * que la subida se registra y se reenvía a `POST /imports/local` con rutas inventadas: la
   * subida multipart en sí la prueban los tests de la API.
   */
  async function forwardUpload(form: FormData, headers: Headers): Promise<Response> {
    const fileOf = (name: string) => {
      const value = form.get(name);
      return value instanceof File ? { name: value.name, size: value.size } : null;
    };
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : null;
    };
    const upload: UploadedForm = {
      file: fileOf("file"),
      media: fileOf("media"),
      broker: text("broker"),
      dryRun: text("dryRun"),
    };
    uploads.push(upload);
    headers.set("content-type", "application/json");
    return app.request("http://localhost:5173/imports/local", {
      method: "POST",
      headers,
      body: JSON.stringify({
        xlsxPath: `/staging/${upload.file?.name ?? "sin-archivo.xlsx"}`,
        ...(upload.media ? { mediaDir: `/staging/${upload.media.name}` } : {}),
        ...(upload.broker ? { broker: upload.broker } : {}),
        dryRun: upload.dryRun === "true",
      }),
    });
  }

  const renderApp = (initialPath = "/"): void => {
    render(
      <App
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        inMemory
        initialPath={initialPath}
      />,
    );
  };

  return {
    client,
    /** La autenticación de la API (los dobles de core, con el administrador sembrado). */
    auth,
    requests,
    uploads,
    listings,
    brokers,
    media,
    importRuns,
    contentRuns: content.contentRuns,
    contents: content.contents,
    platformAccounts,
    renderApp,
    signInAsBroker,
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
    const run = await h.contentRuns.latest(listing.id);
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
