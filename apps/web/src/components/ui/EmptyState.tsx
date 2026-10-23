import type { ReactNode } from "react";
import { HomeIllustration } from "./illustrations.js";

/**
 * Lo que se ve cuando una lista no tiene nada: una ilustración de hogar (F9.5-T26), qué falta y
 * cómo seguir. `icon` acompaña a la ilustración con el ícono de lo que falta; `illustration`
 * la reemplaza.
 */
export function EmptyState({
  icon,
  illustration,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  illustration?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-line-soft bg-surface/70 px-6 py-10 text-center">
      <span className="relative inline-flex">
        {illustration ?? <HomeIllustration className="w-36" />}
        {icon !== undefined && (
          <span className="absolute -right-1 bottom-1 grid size-9 place-items-center rounded-full bg-surface text-brand-800 shadow-sm ring-1 ring-line">
            {icon}
          </span>
        )}
      </span>
      <p className="mt-4 font-display text-lg font-semibold text-fg">{title}</p>
      {description !== undefined && (
        <div className="mt-1 max-w-md text-sm text-fg-muted">{description}</div>
      )}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  );
}
