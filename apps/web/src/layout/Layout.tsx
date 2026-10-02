import { Suspense } from "react";
import { NavLink, Outlet } from "react-router";
import { PublishModeBanner } from "./PublishModeBanner.js";

type MenuItem = { label: string; to?: string; phase?: string; end?: boolean };

/** Cada sección se habilita en su fase. `end`: solo se marca en esa ruta exacta. */
export const MENU: readonly MenuItem[] = [
  { label: "Estado", to: "/", end: true },
  // Sin `end`: también queda marcada en el detalle (`/propiedades/:id`).
  { label: "Propiedades", to: "/propiedades" },
  { label: "Importar", to: "/importar" },
  { label: "Publicaciones", phase: "F3" },
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

export function Layout() {
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
            {MENU.map((item) => (
              <li key={item.label} className="shrink-0">
                <MenuEntry item={item} />
              </li>
            ))}
          </ul>
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
