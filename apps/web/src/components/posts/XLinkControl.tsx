import type { ContentView, PostJson } from "@agentsales/api/contracts";
import {
  formatXUsd,
  LANGUAGE_TEXT,
  X_LINK_POST_COST_USD,
  X_POST_COST_USD,
  xPostHasLink,
} from "@agentsales/core";
import { useUpdatePost } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { useBrandPlatforms } from "./brand-platforms.js";

/** Lo que cuesta un enlace en X (`x.md` §2, spec F9 §4.12), con los montos de core. */
export const X_LINK_COST_TEXT = `${formatXUsd(X_LINK_POST_COST_USD)} en vez de ${formatXUsd(X_POST_COST_USD)}`;

/**
 * Un texto de X que lleva un enlace sin la marca del post (`xLinkAllowed`, F9-T16): la revisión lo
 * da por error (`LINK_NOT_ALLOWED`) y no se aprueba hasta permitirlo o quitar el enlace.
 */
export const needsXLinkMark = (
  post: Pick<PostJson, "xLinkAllowed">,
  content: Pick<ContentView, "platform" | "body">,
): boolean => content.platform === "x" && !post.xLinkAllowed && xPostHasLink(content.body);

/**
 * «Permitir un enlace en X» (F9-T16, spec F9 §4.4): la marca explícita del operador por post. Sin
 * ella, un texto de X con enlace no se aprueba; con ella, ese post cuesta más en X. Se muestra si el
 * post sale en X (o ya tiene un texto de X); cambia con `PATCH /posts/:id`.
 */
export function XLinkControl({
  post,
  contents,
  lockReason,
}: {
  post: PostJson;
  contents: readonly ContentView[];
  lockReason: string | null;
}) {
  const update = useUpdatePost(post.id);
  const brandNetworks = useBrandPlatforms(post.brokerId);
  const onX = post.platforms === null ? brandNetworks.includes("x") : post.platforms.includes("x");
  const xTexts = contents.filter((content) => content.platform === "x");
  if (!onX && xTexts.length === 0) return null;
  // Mientras se guarda, el valor pedido (la consulta del post se refresca al terminar).
  const allowed =
    update.isPending && update.variables?.xLinkAllowed !== undefined
      ? update.variables.xLinkAllowed
      : post.xLinkAllowed;
  const unmarked = xTexts.filter((content) => needsXLinkMark(post, content));
  return (
    <fieldset
      aria-label="Enlace en X"
      className="rounded-xl border border-line bg-surface p-4 text-sm shadow-xs"
    >
      <label className="flex items-center gap-2 font-medium text-fg">
        <input
          type="checkbox"
          checked={allowed}
          disabled={update.isPending || lockReason !== null}
          title={lockReason ?? undefined}
          onChange={(event) => update.mutate({ xLinkAllowed: event.target.checked })}
        />
        Permitir un enlace en X
      </label>
      <p className="mt-1.5 text-xs text-fg-muted">
        {allowed ? "Permitido" : "No permitido"}. En X, un post con enlace cuesta {X_LINK_COST_TEXT}{" "}
        (estimado). El enlace también tiene que estar en el brief.
      </p>
      {unmarked.length > 0 && (
        <p className="mt-3 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-warning-800">
          El texto de X en {unmarked.map((content) => LANGUAGE_TEXT[content.language]).join(" y ")}{" "}
          lleva un enlace y el post no lo permite: no se puede aprobar. Marca «Permitir un enlace en
          X» (cuesta {formatXUsd(X_LINK_POST_COST_USD)}) o quita el enlace del texto.
        </p>
      )}
      {update.error && <ErrorAlert error={update.error} />}
    </fieldset>
  );
}
