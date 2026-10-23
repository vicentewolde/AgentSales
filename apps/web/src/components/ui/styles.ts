// Las clases del sistema visual (F9.5-T01; el aspecto acogedor de F9.5-T26), en un `.ts` aparte
// porque un archivo de componente solo exporta componentes. Los componentes de esta carpeta las
// usan; un control que no puede ser uno de ellos (un `<label>` con forma de botón, un `NavLink`)
// usa la función directamente.

/** Junta clases y deja fuera las vacías (`false`, `null`, `undefined`, `""`). */
export const cx = (...parts: readonly (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md";

// Botones en píldora. Los normales miden 44 px de alto; los chicos, 36 px con el mouse y 44 px en
// una pantalla táctil (`pointer-coarse`).
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-brand-700 text-surface shadow-xs not-disabled:hover:bg-brand-800",
  secondary:
    "border border-line-strong bg-surface text-fg shadow-xs not-disabled:hover:border-brand-300 not-disabled:hover:bg-canvas",
  danger: "bg-danger-700 text-surface shadow-xs not-disabled:hover:bg-danger-800",
  ghost: "text-fg-muted not-disabled:hover:bg-sand not-disabled:hover:text-fg",
  link: "py-1 text-brand-800 underline underline-offset-2 not-disabled:hover:text-brand-900",
};

const BUTTON_SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: "min-h-9 px-3.5 py-1.5 text-sm pointer-coarse:min-h-11",
  md: "min-h-11 px-5 py-2 text-[0.9375rem]",
};

/**
 * Las clases de un botón (o de un enlace con forma de botón). `link` no lleva relleno lateral ni
 * tamaño de letra (toma el del texto que lo rodea); su relleno vertical agranda el área del clic.
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
  neutral: { badge: "bg-surface text-fg-muted ring-1 ring-line-strong", dot: "bg-fg-subtle" },
  muted: { badge: "bg-sand text-fg-muted", dot: "bg-line-strong" },
  brand: { badge: "bg-brand-50 text-brand-900", dot: "bg-brand-500" },
  info: { badge: "bg-info-50 text-info-800", dot: "bg-info-500" },
  success: { badge: "bg-success-50 text-success-800", dot: "bg-success-500" },
  warning: { badge: "bg-warning-50 text-warning-800", dot: "bg-warning-500" },
  danger: { badge: "bg-danger-50 text-danger-800", dot: "bg-danger-500" },
  accent: { badge: "bg-accent-50 text-accent-800", dot: "bg-accent-500" },
};

export const BADGE_BASE =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-inset";

/** Un campo de texto, una lista o un área de texto (sin el ancho: lo pone quien lo usa). */
export const FIELD_CONTROL =
  "block min-h-11 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[0.9375rem] text-fg shadow-xs placeholder:text-fg-subtle focus:border-brand-700 focus:outline-none focus:ring-3 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-canvas disabled:text-fg-subtle aria-invalid:border-danger-600";

/** Un selector de archivos: el botón con la forma de un botón secundario. */
export const FILE_INPUT =
  "text-sm text-fg-muted file:mr-3 file:min-h-11 file:rounded-full file:border file:border-line-strong file:bg-surface file:px-4 file:py-2 file:text-sm file:font-semibold file:text-fg hover:file:bg-canvas";

/** La etiqueta de un campo. */
export const FIELD_LABEL = "block text-sm font-medium text-fg";

/** Una tarjeta: superficie crema, esquinas de 24 px y una sombra tibia en vez de un borde. */
export const CARD = "rounded-3xl bg-surface shadow-card";

export type AlertTone = "info" | "success" | "warning" | "danger";

export const ALERT_TONE: Readonly<Record<AlertTone, { box: string; icon: string; title: string }>> =
  {
    info: {
      box: "border-info-200 bg-info-50 text-info-800",
      icon: "text-info-700",
      title: "text-info-800",
    },
    success: {
      box: "border-success-200 bg-success-50 text-success-800",
      icon: "text-success-700",
      title: "text-success-800",
    },
    warning: {
      box: "border-warning-200 bg-warning-50 text-warning-800",
      icon: "text-warning-700",
      title: "text-warning-800",
    },
    danger: {
      box: "border-danger-200 bg-danger-50 text-danger-800",
      icon: "text-danger-700",
      title: "text-danger-800",
    },
  };
