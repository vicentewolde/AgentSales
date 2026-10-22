import { type PublishMode, publicationModeText, shownPublicationMode } from "@agentsales/core";
import { cx } from "../ui/styles.js";

/**
 * «simulación» o «en vivo» de una publicación (D4 del spec F9.5): el modo fijado o, mientras no se
 * fija (`modeFixed: false`: una aprobada, una descartada sin intento, una fallida que no empezó en
 * vivo), el del sistema (`publishMode` de `/health`, el del banner). Si ese todavía no se sabe, nada:
 * mejor callar que decir «simulación» sin saberlo.
 */
export function PublicationMode({
  publication,
  publishMode,
  className,
  prefix = "",
  liveOnly = false,
}: {
  publication: { dryRun: boolean; modeFixed: boolean };
  /** El modo del sistema (`undefined` mientras no se sabe). */
  publishMode: PublishMode | undefined;
  className?: string;
  /** Lo que va antes del texto, dentro de él (un separador: si no hay modo, tampoco separador). */
  prefix?: string;
  /** Solo «en vivo» (una celda chica, donde la simulación es lo de siempre). */
  liveOnly?: boolean;
}) {
  const mode = shownPublicationMode(publication, publishMode);
  if (mode === null || (liveOnly && mode !== "live")) return null;
  return (
    <span
      className={cx(
        mode === "live" ? "font-semibold text-danger-700" : "text-fg-subtle",
        className,
      )}
    >
      {prefix}
      {publicationModeText(mode === "dry-run")}
    </span>
  );
}
