import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router";
import { type ApiClient, ApiError } from "./api/client.js";
import { ApiClientContext } from "./api/context.js";
import { routes } from "./routes.js";

/**
 * Un reintento ante fallas pasajeras (red, 5xx). Un 4xx (no existe, pedido inválido) no mejora
 * reintentando, y un `TIMEOUT` ya esperó 35 s: los dos se muestran de inmediato.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (!(error instanceof ApiError)) return failureCount < 1;
  const clientError = error.status !== undefined && error.status < 500;
  return failureCount < 1 && !clientError && error.code !== "TIMEOUT";
}

export type AppProps = {
  /** Solo para tests: el cliente contra la API en proceso, y rutas en memoria. */
  client?: ApiClient;
  queryClient?: QueryClient;
  inMemory?: boolean;
  /** Solo con `inMemory`: ruta inicial. */
  initialPath?: string;
};

export function App({ client, queryClient, inMemory = false, initialPath = "/" }: AppProps) {
  // Se crean una sola vez: un router o un cliente nuevos en cada render perderían el estado.
  const [router] = useState(() =>
    inMemory
      ? createMemoryRouter(routes, { initialEntries: [initialPath] })
      : createBrowserRouter(routes),
  );
  const [queries] = useState(
    () => queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } }),
  );
  const content = (
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return client ? <ApiClientContext value={client}>{content}</ApiClientContext> : content;
}
