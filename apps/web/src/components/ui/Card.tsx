import { type ComponentProps, type ReactNode, useId } from "react";
import { CARD, cx } from "./styles.js";

/**
 * Una tarjeta, con un encabezado opcional (título, descripción y acciones). Como `section` con
 * título, es una región con el nombre del título (o el de `aria-label`, si se lo dan).
 */
export function Card({
  as: Tag = "div",
  title,
  description,
  actions,
  padded = true,
  className,
  children,
  ...rest
}: Omit<ComponentProps<"section">, "title" | "ref"> & {
  as?: "div" | "section" | "article";
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Sin relleno: para una tabla o una lista que llega al borde. */
  padded?: boolean;
}) {
  const headingId = useId();
  const header = title !== undefined || actions !== undefined;
  // Una región toma el nombre de su título; un `div` no es región y no lo necesita.
  const named = Tag !== "div" && title !== undefined && rest["aria-label"] === undefined;
  return (
    <Tag
      {...(named ? { "aria-labelledby": headingId } : {})}
      className={cx(CARD, className)}
      {...rest}
    >
      {header && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 id={headingId} className="text-base font-semibold text-fg">
                {title}
              </h2>
            )}
            {description !== undefined && (
              <div className="mt-0.5 text-sm text-fg-muted">{description}</div>
            )}
          </div>
          {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? "p-4 sm:p-5" : undefined}>{children}</div>
    </Tag>
  );
}
