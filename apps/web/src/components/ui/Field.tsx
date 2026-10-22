import type { ComponentProps, ReactNode } from "react";
import { cx, FIELD_CONTROL, FIELD_LABEL } from "./styles.js";

/**
 * Un campo con su etiqueta, una ayuda y un error. Sin `htmlFor`, la etiqueta envuelve al control
 * (asociación implícita); con `htmlFor`, van uno sobre el otro.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const notes = (
    <>
      {hint !== undefined && (
        <span className="mt-1 block text-xs font-normal text-fg-subtle">{hint}</span>
      )}
      {error !== undefined && error !== null && error !== false && (
        <span className="mt-1 block text-xs font-medium text-danger-700">{error}</span>
      )}
    </>
  );
  if (htmlFor === undefined) {
    return (
      // biome-ignore lint/a11y/noLabelWithoutControl: el control llega en `children`, dentro de la etiqueta.
      <label className={cx(FIELD_LABEL, className)}>
        {label}
        <span className="mt-1.5 block font-normal">{children}</span>
        {notes}
      </label>
    );
  }
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={FIELD_LABEL}>
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {notes}
    </div>
  );
}

type Width = { width?: "full" | "auto" };

export function Input({ width = "full", className, ...rest }: ComponentProps<"input"> & Width) {
  return <input className={cx(FIELD_CONTROL, width === "full" && "w-full", className)} {...rest} />;
}

export function Select({ width = "full", className, ...rest }: ComponentProps<"select"> & Width) {
  return (
    <select
      className={cx(FIELD_CONTROL, "pr-8", width === "full" && "w-full", className)}
      {...rest}
    />
  );
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cx(FIELD_CONTROL, "w-full", className)} {...rest} />;
}
