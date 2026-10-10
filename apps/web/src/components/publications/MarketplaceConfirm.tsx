import type { ListingPublicationView } from "@agentsales/api/contracts";
import { isMarketplaceItemUrl, manualWaitingText, marketplacePriceText } from "@agentsales/core";
import { useId, useRef, useState } from "react";
import { type PublicationAction, useManualWaitRefresh } from "../../queries/publications.js";

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50";
const DANGER = "rounded-md bg-red-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-50";

/**
 * Una publicación de Marketplace que espera el clic final (spec F5 §4.3 y §4.12, F5-T13): en qué
 * está el formulario (`manualWaitingText`, core), el precio que se escribió (en pesos, con la UF
 * usada), el enlace para pegar con "Lo publiqué" (en vivo es obligatorio y se revisa antes con
 * `isMarketplaceItemUrl`; la API lo vuelve a revisar) y "No lo publiqué" (con confirmación: no se
 * deshace, D14). Mientras la ventana sigue abierta, el listado se vuelve a pedir cada 5 s: el worker
 * confirma solo si ve el aviso. Descartar espera: primero se dice si salió (D11).
 */
export function MarketplaceConfirm({
  publication,
  listingId,
  pending,
  run,
}: {
  publication: ListingPublicationView;
  listingId: string;
  pending: boolean;
  run: (action: PublicationAction) => void;
}) {
  const manual = publication.manual;
  useManualWaitRefresh(listingId, manual?.windowOpen ? manual.formReadyAt : null);
  const [url, setUrl] = useState("");
  const [denying, setDenying] = useState(false);
  const denyButton = useRef<HTMLButtonElement>(null);
  const cancelDeny = () => {
    setDenying(false);
    // El botón vuelve a aparecer: el foco vuelve a él.
    requestAnimationFrame(() => denyButton.current?.focus());
  };
  const inputId = useId();
  const errorId = useId();
  const live = !publication.dryRun;
  const trimmed = url.trim();
  const invalid = trimmed !== "" && !isMarketplaceItemUrl(trimmed);
  const canConfirm = !pending && (live ? trimmed !== "" && !invalid : true);

  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">
      <p className="font-medium text-amber-900">{capitalize(manualWaitingText(manual))}</p>
      {manual !== null && (
        <p className="text-slate-700">Precio en el formulario: {marketplacePriceText(manual)}</p>
      )}
      {live ? (
        <div>
          <label htmlFor={inputId} className="block text-xs text-slate-700">
            Enlace del aviso publicado (cópialo de la barra del navegador)
          </label>
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.facebook.com/marketplace/item/…"
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          {invalid && (
            <p id={errorId} className="mt-1 text-xs text-red-700">
              No es el enlace de un aviso de Marketplace: debe tener /marketplace/item/ y el número.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-600">
          Es una simulación: no se abrió Facebook y no hace falta enlace.
        </p>
      )}
      {denying ? (
        <fieldset>
          <legend>
            ¿No lo publicaste? Queda como no publicada y no se deshace: después la reintentas (abre
            un formulario nuevo) o la descartas.
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={pending}
              onClick={() => run({ kind: "not-published", id: publication.id })}
            >
              Sí, no lo publiqué
            </button>
            <button
              type="button"
              // biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación
              autoFocus
              className="text-xs underline"
              onClick={cancelDeny}
            >
              Cancelar
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={!canConfirm}
            onClick={() =>
              run({ kind: "confirm", id: publication.id, ...(live ? { url: trimmed } : {}) })
            }
          >
            {live ? "Lo publiqué" : "Lo publiqué (simulación)"}
          </button>
          <button
            ref={denyButton}
            type="button"
            className={BUTTON}
            disabled={pending}
            onClick={() => setDenying(true)}
          >
            No lo publiqué
          </button>
        </div>
      )}
      <p className="text-xs text-slate-600">Para descartarla, primero di si la publicaste.</p>
    </div>
  );
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
