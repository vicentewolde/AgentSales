// Las clases del sistema visual (F9.5-T01), en un `.ts` aparte porque un archivo de componente solo
// exporta componentes. Los componentes de esta carpeta las usan; un control que no puede ser uno
// de ellos (un `<label>` con forma de botón, un `NavLink`) usa la función directamente.

/** Junta clases y deja fuera las vacías (`false`, `null`, `undefined`, `""`). */
export const cx = (...parts: readonly (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-brand-700 text-white shadow-xs not-disabled:hover:bg-brand-800",
  secondary:
    "border border-line-strong bg-surface text-fg shadow-xs not-disabled:hover:bg-slate-50 not-disabled:hover:border-slate-400",
  danger: "bg-danger-700 text-white shadow-xs not-disabled:hover:bg-danger-800",
  ghost: "text-fg-muted not-disabled:hover:bg-slate-100 not-disabled:hover:text-fg",
  link: "inline text-brand-700 underline underline-offset-2 not-disabled:hover:text-brand-900",
};

const BUTTON_SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
};

/**
 * Las clases de un botón (o de un enlace con forma de botón). `link` no lleva relleno ni tamaño de
 * letra: toma el del texto que lo rodea.
 */
export const buttonClasses = (
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
): string =>
  cx(BUTTON_BASE, BUTTON_VARIANT[variant], variant === "link" ? undefined : BUTTON_SIZE[size]);

/** Los tonos de una insignia: el estado se dice con palabras; el color solo acompaña. */
export type BadgeTone =
  | "neutral"
  | "muted"
  | "brand"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export const BADGE_TONE: Readonly<Record<BadgeTone, { badge: string; dot: string }>> = {
  neutral: { badge: "bg-slate-100 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
  muted: { badge: "bg-slate-50 text-slate-600 ring-slate-200", dot: "bg-slate-300" },
  brand: { badge: "bg-brand-50 text-brand-700 ring-brand-200", dot: "bg-brand-500" },
  info: { badge: "bg-info-50 text-info-800 ring-info-200", dot: "bg-info-500" },
  success: { badge: "bg-success-50 text-success-800 ring-success-200", dot: "bg-success-500" },
  warning: { badge: "bg-warning-50 text-warning-800 ring-warning-200", dot: "bg-warning-500" },
  danger: { badge: "bg-danger-50 text-danger-800 ring-danger-200", dot: "bg-danger-500" },
  accent: { badge: "bg-accent-50 text-accent-800 ring-accent-200", dot: "bg-accent-500" },
};

export const BADGE_BASE =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";

/** Un campo de texto, una lista o un área de texto (sin el ancho: lo pone quien lo usa). */
export const FIELD_CONTROL =
  "block rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-fg shadow-xs placeholder:text-fg-subtle focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-fg-subtle aria-invalid:border-danger-500";

/** Un selector de archivos: el botón con la forma de un botón secundario. */
export const FILE_INPUT =
  "text-sm text-fg-muted file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg hover:file:bg-slate-50";

/** La etiqueta de un campo. */
export const FIELD_LABEL = "block text-sm font-medium text-fg";

/** Una tarjeta: borde sutil en vez de sombra pesada. */
export const CARD = "rounded-xl border border-line bg-surface shadow-xs";

export type AlertTone = "info" | "success" | "warning" | "danger";

export const ALERT_TONE: Readonly<Record<AlertTone, { box: string; icon: string; title: string }>> =
  {
    info: {
      box: "border-info-200 bg-info-50 text-info-800",
      icon: "text-info-600",
      title: "text-info-800",
    },
    success: {
      box: "border-success-200 bg-success-50 text-success-800",
      icon: "text-success-600",
      title: "text-success-800",
    },
    warning: {
      box: "border-warning-200 bg-warning-50 text-warning-800",
      icon: "text-warning-600",
      title: "text-warning-800",
    },
    danger: {
      box: "border-danger-200 bg-danger-50 text-danger-800",
      icon: "text-danger-600",
      title: "text-danger-800",
    },
  };
