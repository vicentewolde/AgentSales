import type { ComponentProps } from "react";
import { Link } from "react-router";
import { Spinner } from "./Spinner.js";
import { type ButtonSize, type ButtonVariant, buttonClasses, cx } from "./styles.js";

type Look = { variant?: ButtonVariant; size?: ButtonSize };

/**
 * Un botón del panel: primario (la acción principal), secundario, peligro (borrar, publicar en
 * vivo), fantasma (acciones discretas) o enlace. `loading` lo desactiva y muestra el indicador sin
 * cambiar su nombre; el texto de «Guardando…», si hace falta, lo pone quien lo usa.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: ComponentProps<"button"> & Look & { loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClasses(variant, size), className)}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** Un enlace interno con forma de botón («Nueva carga», «Ver el plan»…). */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & Look) {
  return <Link className={cx(buttonClasses(variant, size), className)} {...rest} />;
}
