import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import {
  createBrowserRouter,
  createMemoryRouter,
  type RouteObject,
  RouterProvider,
} from "react-router";
import type { HealthFetcher } from "./api.js";
import { HealthFetcherContext } from "./health.js";
import { Layout } from "./layout/Layout.js";
import { StatusPage } from "./pages/StatusPage.js";

function NotFound() {
  return <p className="text-slate-600">Esta página no existe.</p>;
}

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <StatusPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export type AppProps = {
  /** Solo para tests: `/health` simulado y rutas en memoria. */
  fetchHealth?: HealthFetcher;
  queryClient?: QueryClient;
  inMemory?: boolean;
  /** Solo con `inMemory`: ruta inicial. */
  initialPath?: string;
};

export function App({ fetchHealth, queryClient, inMemory = false, initialPath = "/" }: AppProps) {
  // Se crean una sola vez: un router o un cliente nuevos en cada render perderían el estado.
  const [router] = useState(() =>
    inMemory
      ? createMemoryRouter(routes, { initialEntries: [initialPath] })
      : createBrowserRouter(routes),
  );
  const [client] = useState(
    () => queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: 1 } } }),
  );
  const content = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return fetchHealth ? (
    <HealthFetcherContext value={fetchHealth}>{content}</HealthFetcherContext>
  ) : (
    content
  );
}
