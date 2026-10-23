import type { ComponentProps, ReactNode } from "react";
import { CheckCircleIcon, ErrorIcon, InfoIcon, WarningIcon } from "./icons.js";
import { ALERT_TONE, type AlertTone, cx } from "./styles.js";

const ICON = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: WarningIcon,
  danger: ErrorIcon,
} as const;

/**
 * Un aviso con su tono. El rol (`alert` o `status`) lo decide quien lo usa: no todo aviso se
 * anuncia a los lectores de pantalla.
 */
export function Alert({
  tone = "info",
  title,
  icon = true,
  className,
  children,
  ...rest
}: Omit<ComponentProps<"div">, "title"> & {
  tone?: AlertTone;
  title?: ReactNode;
  icon?: boolean;
}) {
  const colors = ALERT_TONE[tone];
  const Icon = ICON[tone];
  return (
    <div
      className={cx("flex gap-3 rounded-2xl border p-4 text-sm", colors.box, className)}
      {...rest}
    >
      {icon && <Icon className={cx("mt-0.5 size-5 shrink-0", colors.icon)} />}
      <div className="min-w-0 flex-1">
        {title !== undefined && <p className={cx("font-semibold", colors.title)}>{title}</p>}
        {children !== undefined && (
          <div className={title === undefined ? undefined : "mt-1"}>{children}</div>
        )}
      </div>
    </div>
  );
}
