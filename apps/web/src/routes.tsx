import { lazy } from "react";
import type { RouteObject } from "react-router";
import { Layout } from "./layout/Layout.js";

// Cada página se carga al visitarla (D5 del spec F1): el bundle inicial queda más chico.
const StatusPage = lazy(() =>
  import("./pages/StatusPage.js").then((module) => ({ default: module.StatusPage })),
);
const ListingsPage = lazy(() =>
  import("./pages/ListingsPage.js").then((module) => ({ default: module.ListingsPage })),
);
const ListingDetailPage = lazy(() =>
  import("./pages/ListingDetailPage.js").then((module) => ({ default: module.ListingDetailPage })),
);

function NotFound() {
  return <p className="text-slate-600">Esta página no existe.</p>;
}

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <StatusPage /> },
      { path: "propiedades", element: <ListingsPage /> },
      { path: "propiedades/:id", element: <ListingDetailPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];
