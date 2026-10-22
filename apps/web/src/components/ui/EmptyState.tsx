import type { ReactNode } from "react";
import { InboxIcon } from "./icons.js";

/** Lo que se ve cuando una lista no tiene nada: qué falta y cómo seguir. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-slate-100 text-fg-subtle">
        {icon ?? <InboxIcon className="size-5" />}
      </span>
      <p className="mt-4 text-sm font-semibold text-fg">{title}</p>
      {description !== undefined && (
        <div className="mt-1 max-w-md text-sm text-fg-muted">{description}</div>
      )}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  );
}
