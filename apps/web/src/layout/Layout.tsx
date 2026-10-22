import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, Suspense, useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { onSessionExpired } from "../api/session-events.js";
import { BrokerSelector } from "../components/BrokerSelector.js";
import {
  CalendarIcon,
  ChartIcon,
  HomeIcon,
  LightbulbIcon,
  LinkIcon,
  LogoMark,
  LogoutIcon,
  PencilIcon,
  PulseIcon,
  StarIcon,
  UploadIcon,
  UserIcon,
  UsersIcon,
} from "../components/ui/icons.js";
import { Loading } from "../components/ui/Spinner.js";
import { buttonClasses, cx } from "../components/ui/styles.js";
import { useLogout, useMe } from "../queries/auth.js";
import { BrokerScopeProvider } from "../scope/BrokerScopeProvider.js";
import { useBrokerScope, useCan, useRole, useScopedBrokerKind } from "../scope/broker-scope.js";
import { PublishModeBanner } from "./PublishModeBanner.js";

type MenuItem = {
  label: string;
  to?: string;
  phase?: string;
  end?: boolean;
  /** El ícono de la entrada (decorativo: el nombre lo da `label`). */
  icon: (props: { className?: string }) => ReactNode;
  /** Solo con ese permiso (F7, `can` de core): Corredores, quien crea corredores. */
  needs?: "brokers.create";
  /** Solo para el usuario de un corredor (F7): Mi marca. */
  brokerOnly?: boolean;
  /** Lo de avisos (F9, ADR-0029): no se muestra cuando se mira una marca (`kind = brand`). */
  listings?: boolean;
};

/** Cada sección se habilita en su fase. `end`: solo se marca en esa ruta exacta. */
export const MENU: readonly MenuItem[] = [
  { label: "Estado", to: "/", end: true, icon: PulseIcon },
  // Sin `end`: también queda marcada en el detalle (`/propiedades/:id`).
  { label: "Propiedades", to: "/propiedades", listings: true, icon: HomeIcon },
  { label: "Importar", to: "/importar", listings: true, icon: UploadIcon },
  // F9-T17: los posts, para marcas y corredores (sin `end`: también el detalle).
  { label: "Contenido", to: "/contenido", icon: PencilIcon },
  // F9-T21: el plan de ideas de la IA (pedirlo, aceptar, editar y descartar ideas).
  { label: "Plan", to: "/plan", icon: LightbulbIcon },
  // F9-T18: lo programado y lo publicado, de posts y avisos, por semana o por mes.
  { label: "Calendario", to: "/calendario", icon: CalendarIcon },
  { label: "Seguimiento", to: "/seguimiento", icon: ChartIcon },
  { label: "Cuentas", to: "/cuentas", icon: LinkIcon },
  { label: "Corredores", to: "/corredores", needs: "brokers.create", icon: UsersIcon },
  { label: "Mi marca", to: "/mi-marca", brokerOnly: true, icon: StarIcon },
];

const ENTRY =
  "group flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors";

function MenuEntry({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  if (!item.to) {
    return (
      <span
        aria-disabled="true"
        title={`Disponible en ${item.phase}`}
        className={cx(ENTRY, "cursor-not-allowed text-fg-subtle")}
      >
        <Icon className="size-5 shrink-0" />
        {item.label} <span className="text-xs">({item.phase})</span>
      </span>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      className={({ isActive }) =>
        cx(
          ENTRY,
          isActive
            ? "bg-brand-50 text-brand-800"
            : "text-fg-muted hover:bg-slate-100 hover:text-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cx(
              "size-5 shrink-0",
              isActive ? "text-brand-600" : "text-fg-subtle group-hover:text-fg-muted",
            )}
          />
          {item.label}
        </>
      )}
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

/** Las iniciales del nombre, para el círculo del usuario. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

/** El usuario de la sesión, "Mi cuenta" y "Cerrar sesión". */
function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { select } = useBrokerScope();
  if (me.data === undefined) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 md:mt-auto md:block md:pt-4">
      <div className="flex min-w-0 items-center gap-3 px-1">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-fg-muted"
        >
          {initials(me.data.name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{me.data.name}</p>
          <p className="hidden truncate text-xs text-fg-subtle md:block">{me.data.email}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 md:mt-2">
        <Link to="/cuenta" className={cx(buttonClasses("ghost", "sm"), "px-2")}>
          <UserIcon className="size-4" />
          Mi cuenta
        </Link>
        <button
          type="button"
          className={cx(buttonClasses("ghost", "sm"), "px-2")}
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
          <LogoutIcon className="size-4" />
          Cerrar sesión
        </button>
      </div>
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
    // En pantalla ancha, un marco fijo: la barra lateral y el contenido se desplazan cada uno.
    <div className="flex min-h-screen flex-col bg-canvas md:h-screen md:min-h-0">
      <PublishModeBanner />
      <div className="flex flex-1 flex-col md:min-h-0 md:flex-row">
        <nav
          aria-label="Menú principal"
          className="flex flex-col border-b border-line bg-surface px-3 py-3 md:w-64 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0 md:px-4 md:py-5"
        >
          <p className="flex items-center gap-2.5 px-1 text-fg">
            <LogoMark className="size-8" />
            <span className="text-base font-semibold tracking-tight">AgentSales</span>
          </p>
          <BrokerSelector />
          <ul className="mt-3 flex gap-1 overflow-x-auto [scrollbar-width:none] md:mt-5 md:flex-col">
            {menu.map((item) => (
              <li key={item.label} className="shrink-0">
                <MenuEntry item={item} />
              </li>
            ))}
          </ul>
          <UserMenu />
        </nav>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:overflow-y-auto md:px-10 md:py-8">
          <div className="mx-auto w-full max-w-6xl">
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
