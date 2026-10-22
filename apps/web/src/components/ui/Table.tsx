import type { ComponentProps } from "react";
import { CARD, cx } from "./styles.js";

/**
 * Una tabla con los estilos del panel (`.ui-table` en `index.css`), dentro de una tarjeta que se
 * desplaza de lado en pantallas angostas. Las celdas de cifras llevan `className="num"`.
 */
export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <div className={cx(CARD, "overflow-x-auto")}>
      <table className={cx("ui-table", className)} {...rest} />
    </div>
  );
}
