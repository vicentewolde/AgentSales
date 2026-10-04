import {
  canPrepareContent,
  contentRunProgressText,
  isTerminalContentRun,
  LISTING_NOT_PREPARABLE_TEXT,
  type ListingStatus,
  PLATFORM_TEXT,
} from "@agentsales/core";
import { useState } from "react";
import { ApiError } from "../../api/client.js";
import { useContentRun, useListingContent, useRequestContentRun } from "../../queries/content.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Preview } from "./Preview.js";
import { RunProgress, RunResult } from "./RunStatus.js";

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";

/**
 * La sección Contenido del detalle (spec F2 §4.7, F2-T14): preparar y rehacer imágenes, el avance
 * por etapa (sondeado como una carga), el error de la última corrida y la vista previa por canal
 * con su revisión editorial.
 *
 * La corrida que se sigue es la activa del aviso (aunque la haya pedido la CLI u otra pestaña) o,
 * si no hay, la que se pidió aquí, para mostrar cómo terminó.
 */
export function ContentSection({
  listingId,
  listingStatus,
}: {
  listingId: string;
  listingStatus: ListingStatus;
}) {
  const content = useListingContent(listingId);
  const request = useRequestContentRun(listingId);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [reused, setReused] = useState(false);

  const latest = content.data?.latestRun ?? null;
  const latestActive = latest !== null && !isTerminalContentRun(latest.status) ? latest : null;
  const activeId = latestActive?.id ?? requestedId;
  const { query: run, stopped } = useContentRun(listingId, activeId);
  // Mientras su consulta carga (o falla), la corrida activa del aviso ya cuenta como en curso.
  const tracked = run.data ?? (activeId === latestActive?.id ? latestActive : null);
  const inProgress = tracked !== null && !isTerminalContentRun(tracked.status);
  const shown = tracked ?? latest;
  const preparable = canPrepareContent(listingStatus);

  const start = (texts: boolean, replaceEdits = false) => {
    setConfirmReplace(false);
    setReused(false);
    request.mutate(
      { texts, replaceEdits },
      {
        onSuccess: ({ contentRun, reused: wasReused }) => {
          setRequestedId(contentRun.id);
          setReused(wasReused);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "CONTENT_EDITED") setConfirmReplace(true);
        },
      },
    );
  };
  const busy = request.isPending || inProgress;
  const editedPlatforms = (content.data?.contents ?? [])
    .filter((item) => item.status === "edited")
    .map((item) => PLATFORM_TEXT[item.platform]);
  // Regenerar textos sobre una edición a mano: se confirma antes de pedir (la API igual lo revisa
  // con `CONTENT_EDITED`, por si la edición se hizo en otra pestaña).
  const prepare = () => (editedPlatforms.length > 0 ? setConfirmReplace(true) : start(true));
  // Mientras se regeneran los textos no se edita: la corrida reemplazaría la edición.
  const lockReason =
    (inProgress && tracked?.texts) || (request.isPending && request.variables?.texts)
      ? "Se están regenerando los textos: la edición se habilita cuando termine la preparación."
      : null;
  const editedConflict =
    request.error instanceof ApiError && request.error.code === "CONTENT_EDITED";
  const empty =
    content.data !== undefined &&
    content.data.contents.length === 0 &&
    content.data.carousel.length === 0;

  return (
    <section aria-labelledby="contenido" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="contenido" className="text-lg font-semibold">
          Contenido
        </h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy || !preparable}
            onClick={prepare}
          >
            Preparar contenido
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !preparable}
            onClick={() => start(false)}
          >
            Rehacer imágenes
          </button>
        </div>
      </div>
      {!preparable && <p className="mt-2 text-sm text-slate-600">{LISTING_NOT_PREPARABLE_TEXT}.</p>}

      {confirmReplace && (
        <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="font-semibold text-amber-900">Hay textos editados a mano</p>
          <p className="mt-1 text-sm text-amber-900">
            {editedPlatforms.length > 0
              ? `Editaste ${editedPlatforms.join(", ")}: se reemplazará tu edición por textos nuevos.`
              : "Se reemplazará tu edición por textos nuevos."}{" "}
            Puedes rehacer solo las imágenes y conservar tus textos.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={request.isPending}
              onClick={() => start(false)}
            >
              Rehacer solo imágenes
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={request.isPending}
              onClick={() => start(true, true)}
            >
              Reemplazar mis textos
            </button>
          </div>
        </div>
      )}
      {request.error && !editedConflict && <ErrorAlert error={request.error} />}

      {/* Siempre montada: los lectores de pantalla anuncian los cambios de una región que ya estaba. */}
      <p aria-live="polite" className="mt-4 font-medium text-slate-800">
        {inProgress && tracked !== null ? `Preparando: ${contentRunProgressText(tracked)}…` : ""}
      </p>
      {inProgress && reused && (
        <p className="text-sm text-slate-600">
          Ya había una preparación en curso de esta propiedad: se muestra esa.
        </p>
      )}
      {inProgress && tracked !== null && (
        <RunProgress
          run={tracked}
          checkedAt={run.dataUpdatedAt}
          stopped={stopped}
          onRetry={() => void run.refetch()}
          retrying={run.isFetching}
        />
      )}
      {run.error && !run.data && (
        <ErrorAlert
          error={run.error}
          onRetry={() => void run.refetch()}
          retrying={run.isFetching}
        />
      )}
      {!inProgress && shown !== null && <RunResult run={shown} />}

      {content.isPending && <p className="mt-4 text-sm text-slate-600">Cargando el contenido…</p>}
      {content.error && (
        <ErrorAlert
          error={content.error}
          onRetry={() => void content.refetch()}
          retrying={content.isFetching}
        />
      )}
      {content.data &&
        (empty ? (
          !inProgress && (
            <p className="mt-4 text-sm text-slate-600">
              Todavía no hay contenido. Prepáralo para ver cómo se vería en cada canal.
            </p>
          )
        ) : (
          <Preview
            content={content.data}
            listingId={listingId}
            lockReason={lockReason}
            onReload={() => void content.refetch()}
          />
        ))}
    </section>
  );
}
