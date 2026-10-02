import { randomUUID } from "node:crypto";
import { type AppDeps, createApp, localAccess } from "@agentsales/api";
import { testDeps } from "@agentsales/api/testing";
import type { BrokerData, FieldDefinition, NewListing } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "@agentsales/core/testing";
import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { App } from "../src/App.js";
import { createApiClient } from "../src/api/client.js";

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
  const app = createApp(
    testDeps({ access: localAccess(8787, 5173), listings, brokers, media, ...options.deps }),
  );
  const requests: string[] = [];
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
      return app.request(`http://localhost:5173${path}`, init);
    },
  });

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

  return { client, requests, listings, brokers, media, renderApp };
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
  sortOrder,
  active: true,
});

export { createInMemoryFieldDefinitionRepository };
