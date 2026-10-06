import { lazy } from "react";
import { Link, type RouteObject, useRouteError } from "react-router";
import { Layout } from "./layout/Layout.js";

// Cada página se carga al visitarla (D5 del spec F1): el bundle inicial queda más chico.
const StatusPage = lazy(() =>
  import("./pages/StatusPage.js").then((module) => ({ default: module.StatusPage })),
);
const ListingsPage = lazy(() =>
  import("./pages/ListingsPage.js").then((module) => ({ default: module.ListingsPage })),
);
const ImportPage = lazy(() =>
  import("./pages/ImportPage.js").then((module) => ({ default: module.ImportPage })),
);
const ImportRunPage = lazy(() =>
  import("./pages/ImportRunPage.js").then((module) => ({ default: module.ImportRunPage })),
);
const AccountsPage = lazy(() =>
  import("./pages/AccountsPage.js").then((module) => ({ default: module.AccountsPage })),
);
const ListingDetailPage = lazy(() =>
  import("./pages/ListingDetailPage.js").then((module) => ({ default: module.ListingDetailPage })),
);

/**
 * Una página que falla al mostrarse, o que no se pudo descargar (por ejemplo, tras reconstruir el
 * panel con la pestaña abierta): un aviso dentro del layout, que conserva el menú y el banner.
 */
function PageError() {
  const error = useRouteError();
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4">
      <p className="font-semibold text-red-800">Esta página tuvo un problema.</p>
      <p className="mt-1 text-sm text-red-700">{detail}</p>
      <p className="mt-3 text-sm">
        Recarga la página, o vuelve a{" "}
        <Link to="/propiedades" className="underline">
          Propiedades
        </Link>
        .
      </p>
    </div>
  );
}

function NotFound() {
  return <p className="text-slate-600">Esta página no existe.</p>;
}

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      {
        // Sin ruta propia: solo atrapa los errores de las páginas, dentro del layout.
        errorElement: <PageError />,
        children: [
          { index: true, element: <StatusPage /> },
          { path: "propiedades", element: <ListingsPage /> },
          { path: "propiedades/:id", element: <ListingDetailPage /> },
          { path: "importar", element: <ImportPage /> },
          { path: "importar/:id", element: <ImportRunPage /> },
          // Adonde vuelve el OAuth (`/cuentas?conectada=instagram` o `?error=`, spec F3 §4.6).
          { path: "cuentas", element: <AccountsPage /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];
