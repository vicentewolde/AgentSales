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
    <header className="mb-8">
      {back !== undefined && (
        <Link
          to={back.to}
          className="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-sm font-medium text-fg-muted hover:text-fg"
        >
          <ChevronLeftIcon className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="text-4xl leading-tight font-normal text-fg sm:text-[2.75rem]">
              {title}
            </h1>
            {meta}
          </div>
          {description !== undefined && (
            <div className="mt-2 max-w-2xl text-base text-fg-subtle">{description}</div>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
