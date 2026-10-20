import { lazy, Suspense } from "react";
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
const TrackingPage = lazy(() =>
  import("./pages/TrackingPage.js").then((module) => ({ default: module.TrackingPage })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage.js").then((module) => ({ default: module.LoginPage })),
);
const InvitationPage = lazy(() =>
  import("./pages/InvitationPage.js").then((module) => ({ default: module.InvitationPage })),
);
const BrokersPage = lazy(() =>
  import("./pages/BrokersPage.js").then((module) => ({ default: module.BrokersPage })),
);
const BrokerPage = lazy(() =>
  import("./pages/BrokerPage.js").then((module) => ({ default: module.BrokerPage })),
);
const MyBrandPage = lazy(() =>
  import("./pages/MyBrandPage.js").then((module) => ({ default: module.MyBrandPage })),
);
const AccountPage = lazy(() =>
  import("./pages/AccountPage.js").then((module) => ({ default: module.AccountPage })),
);
// F9-T17: Contenido (los posts de una marca o corredor).
const PostsPage = lazy(() =>
  import("./pages/PostsPage.js").then((module) => ({ default: module.PostsPage })),
);
const PostDetailPage = lazy(() =>
  import("./pages/PostDetailPage.js").then((module) => ({ default: module.PostDetailPage })),
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

/** Las páginas sin sesión (spec F7 §4.11): fuera del layout, sin menú ni banner. */
function Bare({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<p className="p-6 text-slate-600">Cargando…</p>}>{children}</Suspense>;
}

export const routes: RouteObject[] = [
  {
    path: "entrar",
    element: (
      <Bare>
        <LoginPage />
      </Bare>
    ),
  },
  {
    path: "invitacion",
    element: (
      <Bare>
        <InvitationPage />
      </Bare>
    ),
  },
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
          { path: "seguimiento", element: <TrackingPage /> },
          // F9-T17: Contenido (posts de marca) y el detalle de un post.
          { path: "contenido", element: <PostsPage /> },
          { path: "contenido/:id", element: <PostDetailPage /> },
          // F7-T18: Corredores (el administrador) y Mi marca (el corredor).
          { path: "corredores", element: <BrokersPage /> },
          { path: "corredores/:id", element: <BrokerPage /> },
          { path: "mi-marca", element: <MyBrandPage /> },
          // F8-T16: el doble factor de cada usuario.
          { path: "cuenta", element: <AccountPage /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];
