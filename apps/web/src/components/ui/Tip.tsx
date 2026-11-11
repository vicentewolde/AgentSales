import { type ReactNode, useId } from "react";
import { cx } from "./styles.js";

/**
 * Una ayuda que aparece al pasar el mouse por encima (o al enfocar con el teclado) de lo que
 * envuelve: dice qué hace un botón y qué pasa si lo aprietas. `children` recibe el id de la ayuda
 * para ponerlo en `aria-describedby` del botón, así también la lee un lector de pantalla.
 */
export function Tip({
  text,
  align = "start",
  className,
  children,
}: {
  text: ReactNode;
  /** Hacia dónde crece la ayuda: desde el inicio del botón (por defecto) o desde su final. */
  align?: "start" | "end";
  className?: string;
  children: (describedBy: string) => ReactNode;
}) {
  const id = useId();
  return (
    <span className={cx("group relative inline-flex", className)}>
      {children(id)}
      <span
        id={id}
        role="tooltip"
        className={cx(
          // `hidden` (no `invisible`): un globo invisible igual ocupa ancho y la página se desplaza
          // de lado en el celular.
          "pointer-events-none absolute top-full z-30 mt-1.5 hidden w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-3 text-left text-xs font-normal leading-relaxed text-fg shadow-lg",
          "group-hover:block group-focus-within:block",
          align === "end" ? "right-0" : "left-0",
        )}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * Un «?» pequeño con su ayuda, para junto a un título o un campo cuando no hay un botón al que
 * ponérsela.
 */
export function HelpDot({ text, label = "Qué es esto" }: { text: ReactNode; label?: string }) {
  return (
    <Tip text={text} className="align-middle">
      {(describedBy) => (
        <button
          type="button"
          aria-label={label}
          aria-describedby={describedBy}
          className="inline-flex size-5 items-center justify-center rounded-full border border-line bg-canvas text-xs font-semibold text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-brand-700"
        >
          ?
        </button>
      )}
    </Tip>
  );
}
