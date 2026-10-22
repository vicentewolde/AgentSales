import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";
import { cx, FIELD_CONTROL, FIELD_LABEL } from "./styles.js";

type ControlProps = {
  "aria-describedby"?: string;
  "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
};

/**
 * Un campo con su etiqueta, una ayuda y un error. Sin `htmlFor`, la etiqueta envuelve al control
 * (asociación implícita); con `htmlFor`, van uno sobre el otro. La ayuda y el error quedan unidos
 * al control (`aria-describedby`) y, con error, el control queda marcado (`aria-invalid`): por eso
 * `children` es un solo control.
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
  children: ReactElement<ControlProps>;
}) {
  const id = useId();
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== false;
  const hintId = `${id}-ayuda`;
  const errorId = `${id}-error`;
  const own = isValidElement(children) ? children.props["aria-describedby"] : undefined;
  const describedBy =
    [own, hasHint ? hintId : undefined, hasError ? errorId : undefined].filter(Boolean).join(" ") ||
    undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
        ...(hasError ? { "aria-invalid": true } : {}),
      })
    : children;
  const notes = (
    <>
      {hasHint && (
        <span id={hintId} className="mt-1 block text-xs font-normal text-fg-subtle">
          {hint}
        </span>
      )}
      {hasError && (
        <span id={errorId} className="mt-1 block text-xs font-medium text-danger-700">
          {error}
        </span>
      )}
    </>
  );
  if (htmlFor === undefined) {
    return (
      // biome-ignore lint/a11y/noLabelWithoutControl: el control llega en `children`, dentro de la etiqueta.
      <label className={cx(FIELD_LABEL, className)}>
        {label}
        <span className="mt-1.5 block font-normal">{control}</span>
        {notes}
      </label>
    );
  }
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={FIELD_LABEL}>
        {label}
      </label>
      <div className="mt-1.5">{control}</div>
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
