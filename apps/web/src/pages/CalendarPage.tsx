import type { CalendarEntryView } from "@agentsales/api/contracts";
import {
  chileDateOf,
  formatChileTime,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  PUBLICATION_STATUS_TEXT,
  type PublishMode,
  publicationFormatText,
} from "@agentsales/core";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  byChileDay,
  type CalendarView,
  dayLabel,
  periodLabel,
  rangeOfDays,
  shiftAnchor,
  validDay,
  visibleDays,
  WEEKDAYS,
} from "../components/calendar/calendar.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { safeExternalUrl } from "../components/publications/publications.js";
import { ScheduleForm } from "../components/publications/ScheduleForm.js";
import { PUBLICATION_STATUS_TONE } from "../labels.js";
import { useCalendar, useMovePublication } from "../queries/calendar.js";
import { useHealth } from "../queries/health.js";
import { useBrokerFilter, useRole } from "../scope/broker-scope.js";

// F9-T18: el calendario de lo programado y lo publicado, con posts y avisos, por semana o por mes,
// siempre en hora de Chile. Mover la fecha de una programada usa `POST /publications/:id/schedule`
// (el caso de uso de F6) con el selector de programar, que en vivo pide confirmar.

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100";
const TOGGLE_ON = "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white";

/** La hora de Chile de una entrada (`10:00`). */
const timeOf = (entry: CalendarEntryView) => formatChileTime(entry.at).slice(11);

function EntryTitle({ entry }: { entry: CalendarEntryView }) {
  const to =
    entry.postId !== null
      ? `/contenido/${entry.postId}`
      : entry.listingId !== null
        ? `/propiedades/${entry.listingId}`
        : null;
  if (to === null) return <span className="font-semibold">{entry.title}</span>;
  return (
    <Link to={to} className="font-semibold underline">
      {entry.title}
      {entry.postId !== null && <span className="font-normal text-slate-500"> (post)</span>}
    </Link>
  );
}

/** Una publicación en su día: hora, red y formato, estado, modo y título con enlace. */
export function CalendarItem({
  entry,
  showBroker,
  onMove,
}: {
  entry: CalendarEntryView;
  showBroker: boolean;
  onMove: (entry: CalendarEntryView) => void;
}) {
  const url = safeExternalUrl(entry.externalUrl);
  return (
    <li
      className="rounded-md border border-slate-200 bg-white p-2 text-xs"
      aria-label={`${timeOf(entry)} ${PLATFORM_TEXT[entry.platform]} ${entry.title}`}
    >
      <p>
        <span className="font-semibold">{timeOf(entry)}</span> · {PLATFORM_TEXT[entry.platform]}{" "}
        {publicationFormatText(entry.platform, entry.format)}
        {entry.postId !== null && <> · {LANGUAGE_TEXT[entry.language]}</>}
      </p>
      <p className="mt-0.5 break-words">
        <EntryTitle entry={entry} />
      </p>
      {showBroker && entry.brokerSlug !== null && (
        <p className="text-slate-500">{entry.brokerSlug}</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-1">
        <span
          className={`rounded-full px-1.5 py-0.5 font-semibold ${PUBLICATION_STATUS_TONE[entry.status]}`}
        >
          {PUBLICATION_STATUS_TEXT[entry.status]}
        </span>
        {entry.schedule === "overdue" && (
          <span className="font-semibold text-amber-800">atrasada</span>
        )}
        <span className={entry.dryRun ? "text-slate-500" : "font-semibold text-red-700"}>
          {entry.dryRun ? "simulación" : "en vivo"}
        </span>
      </p>
      <p className="mt-1 flex flex-wrap gap-2">
        {entry.kind === "scheduled" && (
          <button type="button" className="text-sky-700 underline" onClick={() => onMove(entry)}>
            Mover
          </button>
        )}
        {url !== null && (
          <a href={url} target="_blank" rel="noreferrer" className="text-sky-700 underline">
            Ver
          </a>
        )}
      </p>
    </li>
  );
}

/** La grilla de días (una semana o las semanas del mes), con lo de cada día. */
export function CalendarGrid({
  view,
  anchor,
  today,
  entries,
  showBroker,
  onMove,
}: {
  view: CalendarView;
  anchor: string;
  today: string;
  entries: readonly CalendarEntryView[];
  showBroker: boolean;
  onMove: (entry: CalendarEntryView) => void;
}) {
  const days = visibleDays(view, anchor);
  const byDay = byChileDay(entries);
  const month = anchor.slice(0, 7);
  return (
    <div className="mt-4">
      <div aria-hidden="true" className="hidden grid-cols-7 gap-2 md:grid">
        {WEEKDAYS.map((weekday) => (
          <p key={weekday} className="px-1 text-xs font-semibold text-slate-500 uppercase">
            {weekday.slice(0, 3)}
          </p>
        ))}
      </div>
      <ol className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-7">
        {days.map((day) => {
          const items = byDay.get(day) ?? [];
          const outside = view === "mes" && !day.startsWith(month);
          // En el teléfono, la vista mensual muestra solo los días con algo.
          const hideOnPhone = items.length === 0 ? "hidden md:block" : "";
          return (
            <li
              key={day}
              aria-label={dayLabel(day)}
              className={`rounded-lg border p-1.5 ${view === "semana" ? "md:min-h-40" : "md:min-h-24"} ${
                day === today ? "border-sky-500 bg-sky-50" : "border-slate-200 bg-slate-50"
              } ${outside ? "opacity-60" : ""} ${view === "mes" ? hideOnPhone : ""}`}
            >
              <p
                className={`text-xs font-semibold ${day === today ? "text-sky-800" : "text-slate-600"}`}
              >
                <span className="md:hidden">{dayLabel(day)}</span>
                <span className="hidden md:inline">{Number(day.slice(8))}</span>
              </p>
              {items.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {items.map((entry) => (
                    <CalendarItem
                      key={entry.publicationId}
                      entry={entry}
                      showBroker={showBroker}
                      onMove={onMove}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Mover la fecha de una programada: el selector de programar (Chile), con la confirmación en vivo. */
function MovePanel({
  entry,
  publishMode,
  onDone,
  onCancel,
}: {
  entry: CalendarEntryView;
  publishMode: PublishMode | undefined;
  onDone: (at: Date) => void;
  onCancel: () => void;
}) {
  const move = useMovePublication();
  const panel = useRef<HTMLElement>(null);
  // El panel va sobre la grilla: al elegir una entrada abajo en el mes, se trae a la vista.
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con cambiar de entrada.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [entry.publicationId]);
  return (
    <section
      ref={panel}
      aria-label="Mover la fecha"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-base font-semibold">Mover la fecha</h2>
      <p className="mt-1 text-sm text-slate-700">
        {PLATFORM_TEXT[entry.platform]} {publicationFormatText(entry.platform, entry.format)} de{" "}
        <EntryTitle entry={entry} />, programada para el {formatChileTime(entry.at)} (hora de
        Chile).
      </p>
      <ScheduleForm
        key={entry.publicationId}
        publishMode={publishMode}
        initial={entry.at}
        pending={move.isPending}
        submitLabel="Mover"
        onSubmit={(at) =>
          move.mutate({ id: entry.publicationId, at }, { onSuccess: () => onDone(new Date(at)) })
        }
        onCancel={onCancel}
      />
      {move.error && <ErrorAlert error={move.error} />}
    </section>
  );
}

/** Calendario (F9-T18): `?vista=semana|mes` y `?dia=AAAA-MM-DD` (hoy en Chile si falta). */
export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const view: CalendarView = params.get("vista") === "mes" ? "mes" : "semana";
  const today = chileDateOf(new Date());
  const anchor = validDay(params.get("dia")) ?? today;
  const broker = useBrokerFilter();
  const role = useRole();
  const health = useHealth();
  const calendar = useCalendar(rangeOfDays(visibleDays(view, anchor)), broker);
  const [moving, setMoving] = useState<CalendarEntryView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const go = (next: { vista?: CalendarView; dia?: string }) => {
    const search = new URLSearchParams(params);
    if (next.vista !== undefined) search.set("vista", next.vista);
    if (next.dia !== undefined) search.set("dia", next.dia);
    setParams(search);
  };

  return (
    <section className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold tracking-tight">Calendario</h1>
      <p className="mt-1 text-sm text-slate-600">
        Lo programado y lo publicado, de propiedades y posts. Las horas son de Chile.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <fieldset className="flex gap-1">
          <legend className="sr-only">Vista</legend>
          {(["semana", "mes"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              className={view === option ? TOGGLE_ON : BUTTON}
              onClick={() => go({ vista: option })}
            >
              {option === "semana" ? "Semana" : "Mes"}
            </button>
          ))}
        </fieldset>
        <div className="flex gap-1">
          <button
            type="button"
            className={BUTTON}
            onClick={() => go({ dia: shiftAnchor(view, anchor, -1) })}
          >
            {view === "semana" ? "Semana anterior" : "Mes anterior"}
          </button>
          <button type="button" className={BUTTON} onClick={() => go({ dia: today })}>
            Hoy
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => go({ dia: shiftAnchor(view, anchor, 1) })}
          >
            {view === "semana" ? "Semana siguiente" : "Mes siguiente"}
          </button>
        </div>
      </div>
      <h2 className="mt-4 text-lg font-semibold">{periodLabel(view, anchor)}</h2>

      {notice !== null && (
        <p role="status" className="mt-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {moving !== null && (
        <MovePanel
          entry={moving}
          publishMode={health.data?.publishMode}
          onDone={(at) => {
            setMoving(null);
            setNotice(`Quedó programada para el ${formatChileTime(at)} (hora de Chile).`);
          }}
          onCancel={() => setMoving(null)}
        />
      )}
      {calendar.error && (
        <ErrorAlert
          error={calendar.error}
          onRetry={() => void calendar.refetch()}
          retrying={calendar.isFetching}
        />
      )}
      {calendar.isPending && <p className="mt-2 text-sm text-slate-600">Cargando el calendario…</p>}
      {calendar.data && (
        <>
          {calendar.data.length === 0 && (
            <p className="mt-2 text-sm text-slate-600">
              Nada programado ni publicado en estas fechas.
            </p>
          )}
          <CalendarGrid
            view={view}
            anchor={anchor}
            today={today}
            entries={calendar.data}
            showBroker={role === "admin" && broker === undefined}
            onMove={(entry) => {
              setNotice(null);
              setMoving(entry);
            }}
          />
        </>
      )}
    </section>
  );
}
