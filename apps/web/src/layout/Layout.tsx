import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { onSessionExpired } from "../api/session-events.js";
import { BrokerSelector } from "../components/BrokerSelector.js";
import { useLogout, useMe } from "../queries/auth.js";
import { BrokerScopeProvider } from "../scope/BrokerScopeProvider.js";
import { useBrokerScope, useCan, useRole, useScopedBrokerKind } from "../scope/broker-scope.js";
import { PublishModeBanner } from "./PublishModeBanner.js";

type MenuItem = {
  label: string;
  to?: string;
  phase?: string;
  end?: boolean;
  /** Solo con ese permiso (F7, `can` de core): Corredores, quien crea corredores. */
  needs?: "brokers.create";
  /** Solo para el usuario de un corredor (F7): Mi marca. */
  brokerOnly?: boolean;
  /** Lo de avisos (F9, ADR-0029): no se muestra cuando se mira una marca (`kind = brand`). */
  listings?: boolean;
};

/** Cada sección se habilita en su fase. `end`: solo se marca en esa ruta exacta. */
export const MENU: readonly MenuItem[] = [
  { label: "Estado", to: "/", end: true },
  // Sin `end`: también queda marcada en el detalle (`/propiedades/:id`).
  { label: "Propiedades", to: "/propiedades", listings: true },
  { label: "Importar", to: "/importar", listings: true },
  { label: "Seguimiento", to: "/seguimiento" },
  { label: "Cuentas", to: "/cuentas" },
  { label: "Corredores", to: "/corredores", needs: "brokers.create" },
  { label: "Mi marca", to: "/mi-marca", brokerOnly: true },
];

function MenuEntry({ item }: { item: MenuItem }) {
  const base = "block rounded-md px-3 py-2 text-sm font-medium";
  if (!item.to) {
    return (
      <span
        aria-disabled="true"
        title={`Disponible en ${item.phase}`}
        className={`${base} cursor-not-allowed text-slate-400`}
      >
        {item.label} <span className="text-xs">({item.phase})</span>
      </span>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      className={({ isActive }) =>
        `${base} ${isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-200"}`
      }
    >
      {item.label}
    </NavLink>
  );
}

/**
 * Si la API dice que no hay sesión (o venció), lleva a "Entrar" y vuelve después a esta página
 * (spec F7 §4.11).
 */
function useSessionGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onSessionExpired(() => {
        queryClient.clear();
        const back = `${location.pathname}${location.search}`;
        navigate(`/entrar?volver=${encodeURIComponent(back)}`, { replace: true });
      }),
    [navigate, location.pathname, location.search, queryClient],
  );
}

/** El usuario de la sesión y "Cerrar sesión". */
function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { select } = useBrokerScope();
  if (me.data === undefined) return null;
  return (
    <div className="mt-3 border-t border-slate-200 px-3 pt-3 text-sm md:mt-4 md:pt-4">
      <p className="font-medium text-slate-800">{me.data.name}</p>
      <p className="truncate text-xs text-slate-500">{me.data.email}</p>
      <Link
        to="/cuenta"
        className="mt-2 mr-3 inline-block text-xs text-slate-600 underline hover:text-slate-900"
      >
        Mi cuenta
      </Link>
      <button
        type="button"
        className="mt-2 text-xs text-slate-600 underline hover:text-slate-900"
        disabled={logout.isPending}
        onClick={() =>
          logout.mutate(undefined, {
            onSuccess: () => {
              // El corredor elegido no pasa a la próxima sesión de la pestaña.
              select(undefined);
              navigate("/entrar", { replace: true });
            },
          })
        }
      >
        Cerrar sesión
      </button>
    </div>
  );
}

export function Layout() {
  return (
    <BrokerScopeProvider>
      <LayoutBody />
    </BrokerScopeProvider>
  );
}

function LayoutBody() {
  useSessionGuard();
  const role = useRole();
  const createsBrokers = useCan("brokers.create");
  const brand = useScopedBrokerKind() === "brand";
  // Mientras no se sabe quién es, sin las entradas condicionadas (nada de más).
  const menu = MENU.filter(
    (item) =>
      (item.needs === undefined || createsBrokers) &&
      (item.brokerOnly !== true || role === "broker") &&
      (item.listings !== true || !brand),
  );
  return (
    <div className="flex min-h-screen flex-col">
      <PublishModeBanner />
      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label="Menú principal"
          className="border-b border-slate-200 bg-white px-4 py-3 md:w-56 md:border-r md:border-b-0 md:py-6"
        >
          <p className="mb-2 hidden px-3 text-lg font-semibold tracking-tight md:block">
            AgentSales
          </p>
          <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col">
            {menu.map((item) => (
              <li key={item.label} className="shrink-0">
                <MenuEntry item={item} />
              </li>
            ))}
          </ul>
          <BrokerSelector />
          <UserMenu />
        </nav>
        <main className="flex-1 px-4 py-6 md:px-8">
          <Suspense fallback={<p className="text-slate-600">Cargando…</p>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
