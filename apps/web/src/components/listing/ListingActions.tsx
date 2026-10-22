import type { ListingStatusResponse } from "@agentsales/api/contracts";
import {
  CLOSE_REASON_TEXT,
  type CloseReason,
  canDoListingAction,
  LISTING_STATUS_TEXT,
  type ListingAction,
  type ListingStatus,
  PLATFORM_TEXT,
  PUBLICATION_STATUS_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import { useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import { useChangeListingStatus } from "../../queries/listings.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";

// F6-T13 (spec F6 §4.8, ADR-0019): la propiedad manda sobre sus publicaciones.

/** Un botón: la acción y, al cerrar, el motivo. */
type Choice = { action: ListingAction; reason?: CloseReason; label: string };

const CHOICES: readonly Choice[] = [
  { action: "ready", label: "Marcar como lista" },
  { action: "pause", label: "Pausar" },
  { action: "resume", label: "Reanudar" },
  { action: "close", reason: "sold", label: "Vendida" },
  { action: "close", reason: "rented", label: "Arrendada" },
  { action: "close", reason: "withdrawn", label: "Retirada" },
  { action: "reopen", label: "Reabrir" },
  { action: "archive", label: "Archivar" },
];

/** Lo que dice la confirmación de cerrar (siempre se confirma: en vivo, Portal no vuelve). */
const closeQuestion = (reason: CloseReason) =>
  `¿Marcar la propiedad como ${CLOSE_REASON_TEXT[reason]}? Se cierra su aviso de Portal (en vivo es definitivo) y se descarta lo pendiente. Lo que esté en vivo en Instagram o Marketplace queda como tarea a mano.`;

const DONE: Readonly<Record<ListingAction, string>> = {
  ready: "La propiedad quedó lista.",
  pause: "La propiedad quedó pausada.",
  resume: "La propiedad se reanudó.",
  close: "La propiedad quedó cerrada.",
  reopen: "La propiedad se reabrió.",
  archive: "La propiedad quedó archivada.",
};

const publicationLine = (publication: ListingStatusResponse["changed"][number]) =>
  `${PLATFORM_TEXT[publication.platform]} ${publicationFormatText(publication.platform, publication.format, publication.mediaIds.length)}`;

/**
 * Las acciones de la propiedad en su detalle (spec F6 §4.8): solo las que salen de su estado
 * (`canDoListingAction`). Cerrar se confirma siempre; pausar y archivar, si la API lo pide
 * (`LISTING_ACTION_NOT_CONFIRMED`, con su motivo). Al terminar, qué cambió y las tareas a mano.
 */
export function ListingActions({ id, status }: { id: string; status: ListingStatus }) {
  const change = useChangeListingStatus(id);
  const [confirming, setConfirming] = useState<{ choice: Choice; question: string } | null>(null);
  const [result, setResult] = useState<{ choice: Choice; body: ListingStatusResponse } | null>(
    null,
  );
  // El botón se desmonta mientras se confirma: se recuerda su texto para devolverle el foco.
  const openerLabel = useRef<string | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const choices = CHOICES.filter((choice) => canDoListingAction(choice.action, status));

  const send = (choice: Choice, confirmed: boolean) => {
    setResult(null);
    change.mutate(
      {
        action: choice.action,
        ...(choice.reason === undefined ? {} : { reason: choice.reason }),
        ...(confirmed ? { confirmed: true } : {}),
      },
      {
        onSuccess: (body) => {
          setConfirming(null);
          setResult({ choice, body });
        },
        onError: (error) => {
          // La API pide confirmar: se muestra su motivo y se repite con `confirmed`.
          if (error instanceof ApiError && error.code === "LISTING_ACTION_NOT_CONFIRMED") {
            change.reset();
            setConfirming({ choice, question: error.message });
          } else {
            setConfirming(null);
          }
        },
      },
    );
  };
  const start = (choice: Choice, button: HTMLButtonElement) => {
    openerLabel.current = button.textContent;
    change.reset();
    if (choice.reason !== undefined) {
      setResult(null);
      setConfirming({ choice, question: closeQuestion(choice.reason) });
      return;
    }
    send(choice, false);
  };
  const cancel = () => {
    setConfirming(null);
    requestAnimationFrame(() => {
      for (const candidate of container.current?.querySelectorAll("button") ?? []) {
        if (candidate.textContent === openerLabel.current) {
          candidate.focus();
          return;
        }
      }
    });
  };

  if (choices.length === 0) return null;
  return (
    <div className="mt-4" ref={container}>
      {confirming === null ? (
        <fieldset
          className="m-0 flex flex-wrap gap-2 border-0 p-0"
          aria-label="Acciones de la propiedad"
        >
          {choices.map((choice) => (
            <Button
              variant="secondary"
              size="sm"
              key={choice.label}
              disabled={change.isPending}
              onClick={(event) => start(choice, event.currentTarget)}
            >
              {choice.label}
            </Button>
          ))}
        </fieldset>
      ) : (
        <div role="alert" className="rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm">
          <p className="font-semibold text-danger-800">{confirming.question}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={change.isPending}
              onClick={() => send(confirming.choice, true)}
            >
              Sí, {confirming.choice.label.toLowerCase()}
            </Button>
            <Button variant="link" autoFocus onClick={cancel}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {change.error && <ErrorAlert error={change.error} />}
      {result !== null && (
        <div role="status" className="mt-3 text-sm text-fg-muted">
          <p>
            {DONE[result.choice.action]} Ahora: {LISTING_STATUS_TEXT[result.body.listing.status]}
            {result.body.listing.closeReason === null
              ? ""
              : ` (${CLOSE_REASON_TEXT[result.body.listing.closeReason]})`}
            .
          </p>
          {result.body.changed.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {result.body.changed.map((publication) => (
                <li key={publication.id}>
                  {publicationLine(publication)}: {PUBLICATION_STATUS_TEXT[publication.status]}
                </li>
              ))}
            </ul>
          )}
          {result.body.manualTasks.length > 0 && (
            <div className="mt-2 rounded-md border border-warning-200 bg-warning-50 p-2 text-warning-800">
              <p className="font-semibold">Tareas a mano</p>
              <p>
                Siguen publicadas en vivo: bórralas en la plataforma y márcalas como retiradas en
                Contenido.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {result.body.manualTasks.map((publication) => (
                  <li key={publication.id}>{publicationLine(publication)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
