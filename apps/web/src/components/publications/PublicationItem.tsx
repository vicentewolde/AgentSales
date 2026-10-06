import type { ListingPublicationView } from "@agentsales/api/contracts";
import {
  PUBLICATION_FORMAT_TEXT,
  PUBLICATION_STATUS_TEXT,
  type PublishMode,
  publicationModeText,
} from "@agentsales/core";
import { useState } from "react";
import { PUBLICATION_STATUS_TONE } from "../../labels.js";
import {
  isPublishing,
  usePublicationAction,
  usePublicationPoll,
} from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { PollStoppedAlert } from "../PollStoppedAlert.js";
import { PublicationEvents } from "./PublicationEvents.js";
import { publicationActions, retryBlockedReason } from "./publications.js";

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const DANGER = "rounded-md bg-red-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-50";

type Confirming = "cancel" | "retire" | null;

/** Las miniaturas de una pendiente (imágenes, o el reel en video, que es el MP4 completo). */
function Thumbnails({ publication }: { publication: ListingPublicationView }) {
  if (publication.media.length === 0) return null;
  const format = PUBLICATION_FORMAT_TEXT[publication.format];
  return (
    <ul aria-label={`Medios del ${format}`} className="mt-2 flex gap-1 overflow-x-auto">
      {publication.media.map((media, index) => (
        <li key={media.id} className="flex-none">
          {media.mime.startsWith("video/") ? (
            <video
              src={media.url}
              preload="metadata"
              muted
              aria-label={`Video del ${format}`}
              className="h-16 w-9 rounded bg-black object-cover"
            />
          ) : (
            <img
              src={media.url}
              alt={`Imagen ${index + 1} del ${format}`}
              loading="lazy"
              className="h-16 w-14 rounded bg-slate-100 object-cover"
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Una publicación (spec F3 §4.9): estado, modo, enlace o error legible, y Reintentar, Descartar y
 * Marcar como retirada (con confirmación; en vivo, que ya se borró a mano). Mientras está en
 * `publishing` se sondea; el tope cuenta desde el clic (`requestedAt`) o el último cambio.
 */
export function PublicationItem({
  publication: listed,
  listingId,
  publishMode,
  requestedAt,
}: {
  publication: ListingPublicationView;
  listingId: string;
  publishMode: PublishMode | undefined;
  requestedAt: Date | null;
}) {
  const { query: poll, stopped } = usePublicationPoll(listingId, listed, requestedAt);
  const action = usePublicationAction(listingId);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [removedByHand, setRemovedByHand] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  // Lo sondeado (de esta misma versión del listado) es lo más nuevo mientras se publica.
  const publication = poll.data === undefined ? listed : { ...listed, ...poll.data };
  const format = PUBLICATION_FORMAT_TEXT[publication.format];
  const actions = publicationActions(publication);
  const retryBlocked = retryBlockedReason(publication, publishMode);
  const live = !publication.dryRun;
  const run = (next: Parameters<typeof action.mutate>[0]) =>
    action.mutate(next, { onSettled: () => setConfirming(null) });

  return (
    <article
      aria-label={`Publicación ${format}`}
      className="rounded-lg border border-slate-200 bg-white p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold capitalize">{format}</h4>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PUBLICATION_STATUS_TONE[publication.status]}`}
        >
          {PUBLICATION_STATUS_TEXT[publication.status]}
        </span>
        <span className="text-xs text-slate-500">{publicationModeText(publication.dryRun)}</span>
      </div>
      {isPublishing(publication.status) && (
        <p aria-live="polite" className="mt-1 text-sm text-slate-700">
          Publicando…
        </p>
      )}
      {publication.externalUrl !== null && (
        <a
          href={publication.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block text-sm break-all text-sky-700 underline"
        >
          Ver en Instagram
        </a>
      )}
      {publication.status === "published" && publication.dryRun && (
        <p className="mt-1 text-xs text-slate-500">Simulación: no se envió nada a Instagram.</p>
      )}
      {publication.lastError !== null && publication.status === "failed" && (
        <p className="mt-1 text-sm text-red-700">{publication.lastError.message}</p>
      )}
      <Thumbnails publication={listed} />
      {stopped && (
        <PollStoppedAlert
          stopped={stopped}
          noun="La publicación"
          onRetry={() => void poll.refetch()}
          retrying={poll.isFetching}
        />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {actions.retry && (
          <button
            type="button"
            className={BUTTON}
            disabled={action.isPending || retryBlocked !== null}
            onClick={() => run({ kind: "publish", id: publication.id })}
          >
            Reintentar
          </button>
        )}
        {actions.cancel && confirming === null && (
          <button type="button" className={BUTTON} onClick={() => setConfirming("cancel")}>
            Descartar
          </button>
        )}
        {actions.retire && confirming === null && (
          <button type="button" className={BUTTON} onClick={() => setConfirming("retire")}>
            Marcar como retirada
          </button>
        )}
        <button
          type="button"
          className="text-xs underline"
          onClick={() => setShowEvents(!showEvents)}
        >
          {showEvents ? "Ocultar bitácora" : "Ver bitácora"}
        </button>
      </div>
      {actions.retry && retryBlocked !== null && (
        <p className="mt-1 text-xs text-amber-800">{retryBlocked}</p>
      )}

      {confirming === "cancel" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>¿Descartar el {format}? El texto sigue aprobado: publicar de nuevo abre otro.</span>
          <button
            type="button"
            className={DANGER}
            disabled={action.isPending}
            onClick={() => run({ kind: "cancel", id: publication.id })}
          >
            Sí, descartar
          </button>
          <button type="button" className="text-xs underline" onClick={() => setConfirming(null)}>
            No
          </button>
        </div>
      )}
      {confirming === "retire" && (
        <div className="mt-2 space-y-2 text-sm">
          {live ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={removedByHand}
                onChange={(event) => setRemovedByHand(event.target.checked)}
              />
              Ya la borré a mano en Instagram (la API no deja borrarla)
            </label>
          ) : (
            <p>Es una simulación: no hay nada que borrar en Instagram.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={DANGER}
              disabled={action.isPending || (live && !removedByHand)}
              onClick={() => run({ kind: "retire", id: publication.id, removedByHand: live })}
            >
              Marcar como retirada
            </button>
            <button type="button" className="text-xs underline" onClick={() => setConfirming(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {action.error && <ErrorAlert error={action.error} />}
      {showEvents && <PublicationEvents publicationId={publication.id} />}
    </article>
  );
}
