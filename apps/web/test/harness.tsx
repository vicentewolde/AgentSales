import { randomUUID } from "node:crypto";
import { type AppDeps, createApp, localAccess } from "@agentsales/api";
import { testDeps } from "@agentsales/api/testing";
import type { BrokerData, FieldDefinition, NewListing } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryImportRunRepository,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "@agentsales/core/testing";
import { QueryClient } from "@tanstack/react-query";
import { configure, render } from "@testing-library/react";
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
  intercept?: (method: string, path: string) => Promise<Response> | Response | undefined;
};

/**
 * La API real en proceso (`createApp` con repositorios en memoria) detrás del cliente del panel,
 * sin red: el proxy de Vite (`/api` → API) se imita quitando el prefijo (spec F1-T13).
 */
export function harness(options: HarnessOptions = {}) {
  const listings = createInMemoryListingRepository({ nextId: randomUUID });
  const brokers = createInMemoryBrokerRepository();
  const media = createInMemoryMediaRepository();
  const importRuns = createInMemoryImportRunRepository({ nextId: randomUUID });
  const app = createApp(
    testDeps({
      access: localAccess(8787, 5173),
      listings,
      brokers,
      media,
      importRuns,
      ...options.deps,
    }),
  );
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
      const intercepted = options.intercept?.(method, path);
      if (intercepted !== undefined) return intercepted;
      // El navegador manda `Origin` en un POST: sin él, `csrf()` rechaza el multipart.
      const headers = new Headers(init?.headers);
      if (method !== "GET") headers.set("origin", "http://localhost:5173");
      if (method === "POST" && path === "/imports" && init?.body instanceof FormData) {
        return forwardUpload(init.body, headers);
      }
      return app.request(`http://localhost:5173${path}`, { ...init, headers });
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

  return { client, requests, uploads, listings, brokers, media, importRuns, renderApp };
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
