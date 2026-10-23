import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, Suspense, useEffect, useId, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { onSessionExpired } from "../api/session-events.js";
import { BrokerSelector } from "../components/BrokerSelector.js";
import { clearAllOneTimeLinks } from "../components/brokers/one-time-link-store.js";
import {
  CalendarIcon,
  ChartIcon,
  CloseIcon,
  HomeIcon,
  LightbulbIcon,
  LinkIcon,
  LogoMark,
  LogoutIcon,
  MenuIcon,
  PencilIcon,
  PulseIcon,
  StarIcon,
  SunIcon,
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
  /** Solo para el administrador (F9.5, D11): Estado. */
  adminOnly?: boolean;
  /** Lo de avisos (F9, ADR-0029): no se muestra cuando se mira una marca (`kind = brand`). */
  listings?: boolean;
};

/** Cada sección se habilita en su fase. `end`: solo se marca en esa ruta exacta. */
export const MENU: readonly MenuItem[] = [
  // F9.5-T03 (D11): la portada, para todos.
  { label: "Hoy", to: "/", end: true, icon: SunIcon },
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
  // F9.5-T03 (D11): la salud del sistema, que antes era la portada.
  { label: "Estado", to: "/estado", adminOnly: true, icon: PulseIcon },
];

const ENTRY =
  "group flex min-h-11 items-center gap-3 whitespace-nowrap rounded-lg px-3.5 py-2 text-[0.9375rem] transition-colors";

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
            ? "bg-surface font-semibold text-fg shadow-xs"
            : "font-medium text-fg-muted hover:bg-sand-strong/60 hover:text-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cx(
              "size-5 shrink-0",
              isActive ? "text-brand-700" : "text-fg-muted group-hover:text-fg",
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
        // Los enlaces de invitación guardados en la pestaña son secretos de esa sesión (F9.5-T20).
        clearAllOneTimeLinks();
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
    <div className="mt-4 rounded-2xl bg-sand-strong p-3 md:mt-auto">
      <div className="flex min-w-0 items-center gap-3 px-1">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-700 text-xs font-semibold text-surface"
        >
          {initials(me.data.name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{me.data.name}</p>
          <p className="truncate text-xs text-fg-muted">{me.data.email}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
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
  // El menú del celular: cerrado al cambiar de página.
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con el cambio de página.
  useEffect(() => setOpen(false), [pathname]);
  const role = useRole();
  const createsBrokers = useCan("brokers.create");
  const brand = useScopedBrokerKind() === "brand";
  // Mientras no se sabe quién es, sin las entradas condicionadas (nada de más).
  const menu = MENU.filter(
    (item) =>
      (item.needs === undefined || createsBrokers) &&
      (item.brokerOnly !== true || role === "broker") &&
      (item.adminOnly !== true || role === "admin") &&
      (item.listings !== true || !brand),
  );
  return (
    // En pantalla ancha, un marco fijo: la barra lateral y el contenido se desplazan cada uno. En el
    // celular, la barra queda arriba y el menú se abre con un botón (F9.5-T26).
    <div className="flex min-h-screen flex-col bg-canvas md:h-screen md:min-h-0">
      <PublishModeBanner />
      <div className="flex flex-1 flex-col md:min-h-0 md:flex-row">
        <nav
          aria-label="Menú principal"
          className="flex flex-col bg-sand px-4 py-3 md:w-68 md:shrink-0 md:overflow-y-auto md:px-5 md:py-7"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-3 px-1 text-fg">
              <LogoMark className="size-9" />
              <span className="font-display text-[1.375rem] font-semibold">AgentSales</span>
            </p>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpen((current) => !current)}
              className={cx(buttonClasses("ghost", "sm"), "min-h-11 px-3 md:hidden")}
            >
              {open ? <CloseIcon className="size-5" /> : <MenuIcon className="size-5" />}
              Menú
            </button>
          </div>
          <div id={menuId} className={cx("flex-1 flex-col md:flex", open ? "flex" : "hidden")}>
            <BrokerSelector />
            <ul className="mt-4 flex flex-col gap-1 md:mt-6">
              {menu.map((item) => (
                <li key={item.label}>
                  <MenuEntry item={item} />
                </li>
              ))}
            </ul>
            <UserMenu />
          </div>
        </nav>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 md:overflow-y-auto md:px-12 md:py-10">
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
