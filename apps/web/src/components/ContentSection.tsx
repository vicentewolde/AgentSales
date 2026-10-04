import type {
  ContentMedia,
  ContentRunView,
  ContentView,
  ListingContentResponse,
} from "@agentsales/api/contracts";
import {
  CONTENT_RUN_STAGE_TEXT,
  CONTENT_RUN_STAGES,
  CONTENT_STATUS_TEXT,
  contentRunProgressText,
  instagramCaption,
  isTerminalContentRun,
  type ListingStatus,
  PLATFORM_TEXT,
  PLATFORMS,
  type Platform,
  RUN_QUEUED_WARNING_TEXT,
} from "@agentsales/core";
import { useState } from "react";
import { ApiError } from "../api/client.js";
import { useContentRun, useListingContent, useRequestContentRun } from "../queries/content.js";
import { stuckInQueue } from "../queries/run-poll.js";
import { ErrorAlert } from "./ErrorAlert.js";

/** Estados en que se puede preparar contenido (spec F2 §4.4); la API lo vuelve a revisar. */
const PREPARABLE: readonly ListingStatus[] = ["ready", "paused", "active"];

/** Lo que Instagram muestra del caption antes de "más" (unos 125 caracteres). */
export const CAPTION_PREVIEW_LENGTH = 125;

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";

/** Las etapas de una corrida, marcando las hechas y la que está en curso. */
function Stages({ run }: { run: ContentRunView }) {
  const stages = CONTENT_RUN_STAGES.filter((stage) => stage !== "texts" || run.texts);
  const current = run.stage === null ? -1 : stages.indexOf(run.stage);
  const mark = (index: number) => {
    if (run.status === "queued") return "pending";
    if (index < current) return "done";
    return index === current ? "current" : "pending";
  };
  return (
    <ol aria-label="Etapas" className="mt-2 space-y-1 text-sm">
      {stages.map((stage, index) => {
        const state = mark(index);
        return (
          <li
            key={stage}
            aria-current={state === "current" ? "step" : undefined}
            className={
              state === "done"
                ? "text-emerald-700"
                : state === "current"
                  ? "font-semibold text-slate-900"
                  : "text-slate-400"
            }
          >
            {state === "done" ? "✓ " : state === "current" ? "→ " : "· "}
            {CONTENT_RUN_STAGE_TEXT[stage]}
          </li>
        );
      })}
    </ol>
  );
}

/** El avance de una corrida en curso, con el aviso si sigue en cola y si se dejó de consultar. */
function Progress({
  run,
  checkedAt,
  stopped,
  onRetry,
  retrying,
}: {
  run: ContentRunView;
  checkedAt: number;
  stopped: "failures" | "max-wait" | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p aria-live="polite" className="font-medium text-slate-800">
        Preparando: {contentRunProgressText(run)}…
      </p>
      <Stages run={run} />
      {stuckInQueue(run, checkedAt) && !stopped && (
        <p role="alert" className="mt-2 text-sm text-amber-800">
          {RUN_QUEUED_WARNING_TEXT}
        </p>
      )}
      {stopped && (
        <div role="alert" className="mt-3 text-sm text-amber-900">
          <p className="font-semibold">
            {stopped === "failures"
              ? "Dejé de consultar: la API no respondió varias veces seguidas."
              : "Dejé de consultar: la preparación lleva más de 2 horas sin terminar."}
          </p>
          <p className="mt-1">
            La preparación sigue en el worker. Revisa que estén corriendo la API y el worker (pnpm
            dev).
          </p>
          <button type="button" onClick={onRetry} disabled={retrying} className={`mt-2 ${BUTTON}`}>
            {retrying ? "Consultando…" : "Consultar de nuevo"}
          </button>
        </div>
      )}
    </div>
  );
}

/** El resultado de la última corrida: el error si falló y sus advertencias. */
function RunResult({ run }: { run: ContentRunView }) {
  const warnings = run.report?.warnings ?? [];
  return (
    <>
      {run.status === "failed" && run.error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-800">La última preparación falló</p>
          <p className="mt-1 text-sm text-red-800">{run.error.message}</p>
          <p className="mt-1 text-xs text-red-700">Código: {run.error.code}</p>
        </div>
      )}
      {warnings.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-amber-800">
            Advertencias de la última preparación ({warnings.length})
          </summary>
          <ul className="mt-1 list-disc pl-5 text-amber-900">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** La revisión editorial de un texto: errores en rojo y advertencias en ámbar. */
function Checks({ content }: { content: ContentView }) {
  return (
    <section
      aria-label={`Revisión editorial de ${PLATFORM_TEXT[content.platform]}`}
      className="mt-3 text-sm"
    >
      {content.checks.length === 0 ? (
        <p className="text-emerald-700">✓ Revisión editorial sin problemas</p>
      ) : (
        <ul className="space-y-1">
          {content.checks.map((check) => (
            <li
              key={`${check.code}-${check.message}`}
              className={
                check.severity === "error"
                  ? "rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800"
                  : "rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"
              }
            >
              <span className="font-semibold">
                {check.severity === "error" ? "Error" : "Advertencia"}:
              </span>{" "}
              {check.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** El caption de Instagram con "más", como en la app: primero solo el comienzo. */
function Caption({ content }: { content: ContentView }) {
  const [expanded, setExpanded] = useState(false);
  const caption = instagramCaption(content);
  const long = caption.length > CAPTION_PREVIEW_LENGTH;
  return (
    <div className="mt-3 text-sm">
      <p className="whitespace-pre-line" data-testid="caption">
        {long && !expanded ? `${caption.slice(0, CAPTION_PREVIEW_LENGTH).trimEnd()}…` : caption}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-sm font-medium text-slate-500 underline"
        >
          {expanded ? "ver menos" : "ver más"}
        </button>
      )}
    </div>
  );
}

function Status({ content }: { content: ContentView }) {
  return (
    <p className="text-xs text-slate-500">
      Texto: {CONTENT_STATUS_TEXT[content.status]}
      {content.status === "edited" ? "" : ` · ${content.promptVersion}`}
    </p>
  );
}

function InstagramPanel({
  content,
  carousel,
  reel,
}: {
  content: ContentView | undefined;
  carousel: ContentMedia[];
  reel: ContentMedia | null;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">Carrusel ({carousel.length})</h3>
        {carousel.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Sin imágenes todavía.</p>
        ) : (
          <ul
            aria-label="Carrusel de Instagram"
            className="mt-2 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2"
          >
            {carousel.map((item, index) => (
              <li key={item.id} className="w-64 flex-none snap-start">
                <img
                  src={item.url}
                  alt={`Imagen ${index + 1} de ${carousel.length} del carrusel`}
                  loading="lazy"
                  className="aspect-[4/5] w-full rounded-md bg-slate-100 object-cover"
                />
              </li>
            ))}
          </ul>
        )}
        <h3 className="mt-4 text-sm font-semibold text-slate-700">Reel</h3>
        {reel === null ? (
          <p className="mt-2 text-sm text-slate-500">Sin reel (la propiedad no tiene video).</p>
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: el texto del reel va dibujado en el video.
          <video
            src={reel.url}
            controls
            preload="metadata"
            aria-label="Reel de Instagram"
            className="mt-2 aspect-[9/16] w-48 rounded-md bg-black"
          />
        )}
      </div>
      <div>
        {content === undefined ? (
          <p className="text-sm text-slate-500">Sin texto todavía.</p>
        ) : (
          <>
            <Status content={content} />
            <Caption content={content} />
            <Checks content={content} />
          </>
        )}
      </div>
    </div>
  );
}

function ListingPanel({
  platform,
  content,
  photos,
}: {
  platform: Platform;
  content: ContentView | undefined;
  photos: ContentMedia[];
}) {
  return (
    <div>
      {content === undefined ? (
        <p className="text-sm text-slate-500">Sin texto todavía.</p>
      ) : (
        <>
          <Status content={content} />
          <h3 className="mt-2 text-lg font-semibold">{content.title}</h3>
          <p className="mt-2 whitespace-pre-line text-sm">{content.body}</p>
          <Checks content={content} />
        </>
      )}
      <h3 className="mt-4 text-sm font-semibold text-slate-700">Fotos ({photos.length})</h3>
      <ul className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        {photos.map((item, index) => (
          <li key={item.id}>
            <img
              src={item.url}
              alt={`Foto ${index + 1} para ${PLATFORM_TEXT[platform]}`}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-md bg-slate-100 object-cover"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Pestañas por canal: lo que se publicaría en cada uno. */
function Preview({ content }: { content: ListingContentResponse }) {
  const [platform, setPlatform] = useState<Platform>("instagram");
  const textOf = (target: Platform) => content.contents.find((item) => item.platform === target);
  const hasErrors = (target: Platform) =>
    textOf(target)?.checks.some((check) => check.severity === "error") ?? false;
  return (
    <div className="mt-4">
      <div role="tablist" aria-label="Canales" className="flex gap-1 border-b border-slate-200">
        {PLATFORMS.map((target) => (
          <button
            key={target}
            type="button"
            role="tab"
            id={`tab-${target}`}
            aria-selected={platform === target}
            aria-controls={`panel-${target}`}
            onClick={() => setPlatform(target)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              platform === target
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {PLATFORM_TEXT[target]}
            {hasErrors(target) && (
              <span className="ml-1 text-red-600" title="La revisión tiene errores">
                ●
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`panel-${platform}`}
        aria-labelledby={`tab-${platform}`}
        className="pt-4"
      >
        {platform === "instagram" ? (
          <InstagramPanel
            content={textOf("instagram")}
            carousel={content.carousel}
            reel={content.reel}
          />
        ) : (
          <ListingPanel platform={platform} content={textOf(platform)} photos={content.photos} />
        )}
      </div>
    </div>
  );
}

/**
 * La sección Contenido del detalle (spec F2 §4.7, F2-T14): preparar y rehacer imágenes, el avance
 * por etapa (sondeado como una carga), el error de la última corrida y la vista previa por canal
 * con su revisión editorial.
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
  const latest = content.data?.latestRun ?? null;
  const activeId =
    requestedId ?? (latest !== null && !isTerminalContentRun(latest.status) ? latest.id : null);
  const { query: run, stopped } = useContentRun(listingId, activeId);
  const current = activeId === null ? null : (run.data ?? null);
  const inProgress = current !== null && !isTerminalContentRun(current.status);
  // El resultado que se muestra: el de la corrida seguida aquí, o la última del aviso.
  const shown = current ?? latest;
  const preparable = PREPARABLE.includes(listingStatus);

  const start = (texts: boolean, replaceEdits = false) => {
    setConfirmReplace(false);
    request.mutate(
      { texts, replaceEdits },
      {
        onSuccess: ({ contentRun }) => setRequestedId(contentRun.id),
        onError: (error) => {
          if (error instanceof ApiError && error.code === "CONTENT_EDITED") setConfirmReplace(true);
        },
      },
    );
  };
  const busy = request.isPending || inProgress;
  const editedConflict =
    request.error instanceof ApiError && request.error.code === "CONTENT_EDITED";

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
            onClick={() => start(true)}
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
      {!preparable && (
        <p className="mt-2 text-sm text-slate-600">
          Para preparar contenido, la propiedad tiene que estar lista, pausada o publicada.
        </p>
      )}

      {confirmReplace && (
        <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="font-semibold text-amber-900">Hay textos editados a mano</p>
          <p className="mt-1 text-sm text-amber-900">
            Preparar de nuevo los reemplazaría por textos nuevos. Puedes rehacer solo las imágenes y
            conservar tus textos.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={BUTTON} onClick={() => start(false)}>
              Rehacer solo imágenes
            </button>
            <button type="button" className={PRIMARY} onClick={() => start(true, true)}>
              Reemplazar mis textos
            </button>
          </div>
        </div>
      )}
      {request.error && !editedConflict && <ErrorAlert error={request.error} />}

      {inProgress && current !== null && (
        <Progress
          run={current}
          checkedAt={run.dataUpdatedAt}
          stopped={stopped}
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
        (content.data.contents.length === 0 && content.data.carousel.length === 0 ? (
          !inProgress && (
            <p className="mt-4 text-sm text-slate-600">
              Todavía no hay contenido. Prepáralo para ver cómo se vería en cada canal.
            </p>
          )
        ) : (
          <Preview content={content.data} />
        ))}
    </section>
  );
}
