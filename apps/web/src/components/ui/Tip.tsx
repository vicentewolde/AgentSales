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
          "pointer-events-none invisible absolute top-full z-30 mt-1.5 w-72 max-w-[80vw] rounded-lg border border-line bg-surface p-3 text-left text-xs font-normal leading-relaxed text-fg opacity-0 shadow-lg transition-opacity",
          "group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100",
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
