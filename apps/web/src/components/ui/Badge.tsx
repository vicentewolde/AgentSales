import type { ReactNode } from "react";
import { BADGE_BASE, BADGE_TONE, type BadgeTone, cx } from "./styles.js";

/**
 * Una insignia de estado: el texto dice el estado y el tono (con su punto) lo acompaña, así se lee
 * también sin color.
 */
export function Badge({
  tone = "neutral",
  dot = true,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const colors = BADGE_TONE[tone];
  return (
    <span className={cx(BADGE_BASE, colors.badge, className)}>
      {dot && <span aria-hidden="true" className={cx("size-1.5 rounded-full", colors.dot)} />}
      {children}
    </span>
  );
}
