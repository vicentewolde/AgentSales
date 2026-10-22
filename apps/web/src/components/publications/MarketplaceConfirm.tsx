import type { ListingPublicationView } from "@agentsales/api/contracts";
import { isMarketplaceItemUrl, manualWaitingText, marketplacePriceText } from "@agentsales/core";
import { useId, useRef, useState } from "react";
import { type PublicationAction, useManualWaitRefresh } from "../../queries/publications.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";

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
    <div className="mt-2 space-y-2 rounded-md border border-warning-200 bg-warning-50 p-2 text-sm">
      <p className="font-medium text-warning-800">{capitalize(manualWaitingText(manual))}</p>
      {manual !== null && (
        <p className="text-fg-muted">
          {manual.byHand ? "Precio para publicar" : "Precio en el formulario"}:{" "}
          {marketplacePriceText(manual)}
        </p>
      )}
      {live ? (
        <div>
          <label htmlFor={inputId} className="block text-xs text-fg-muted">
            Enlace del aviso publicado (cópialo de la barra del navegador)
          </label>
          <Input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.facebook.com/marketplace/item/…"
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            className="mt-1"
          />
          {invalid && (
            <p id={errorId} className="mt-1 text-xs text-danger-700">
              No es el enlace de un aviso de Marketplace: debe tener /marketplace/item/ y el número.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-muted">
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
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => run({ kind: "not-published", id: publication.id })}
            >
              Sí, no lo publiqué
            </Button>
            <Button variant="link" autoFocus className="text-xs" onClick={cancelDeny}>
              Cancelar
            </Button>
          </div>
        </fieldset>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!canConfirm}
            onClick={() =>
              run({ kind: "confirm", id: publication.id, ...(live ? { url: trimmed } : {}) })
            }
          >
            {live ? "Lo publiqué" : "Lo publiqué (simulación)"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            ref={denyButton}
            disabled={pending}
            onClick={() => setDenying(true)}
          >
            No lo publiqué
          </Button>
        </div>
      )}
      <p className="text-xs text-fg-muted">Para descartarla, primero di si la publicaste.</p>
    </div>
  );
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
