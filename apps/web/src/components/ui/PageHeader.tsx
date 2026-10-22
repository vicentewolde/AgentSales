import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeftIcon } from "./icons.js";

/**
 * El encabezado de una página: volver (opcional), el título con lo que lo acompaña (una insignia),
 * la descripción y las acciones a la derecha (abajo en el celular).
 */
export function PageHeader({
  title,
  meta,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  /** Junto al título: una insignia de estado, por ejemplo. */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="mb-6">
      {back !== undefined && (
        <Link
          to={back.to}
          className="-ml-1 mb-2 inline-flex items-center gap-1 rounded-md px-1 text-sm font-medium text-fg-muted hover:text-fg"
        >
          <ChevronLeftIcon className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
            {meta}
          </div>
          {description !== undefined && (
            <div className="mt-1.5 text-sm text-fg-muted">{description}</div>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
