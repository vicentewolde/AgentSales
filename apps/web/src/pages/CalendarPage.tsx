import type { CalendarEntryView } from "@agentsales/api/contracts";
import {
  chileDateOf,
  formatChileTime,
  PLATFORM_TEXT,
  type PublishMode,
  publicationFormatText,
} from "@agentsales/core";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CalendarChip, DayPanel, EntryTitle } from "../components/calendar/CalendarEntries.js";
import {
  applyEntryFilters,
  byChileDay,
  type CalendarView,
  capDay,
  DEFAULT_ENTRY_FILTERS,
  dayLabel,
  type EntryFilters,
  parseEntryFilters,
  periodLabel,
  rangeOfDays,
  shiftAnchor,
  validDay,
  visibleDays,
  WEEKDAYS,
} from "../components/calendar/calendar.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { ScheduleForm } from "../components/publications/ScheduleForm.js";
import { Button } from "../components/ui/Button.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useBrokerModeOf } from "../queries/brokers.js";
import { useCalendar, useMovePublication } from "../queries/calendar.js";
import { SubjectBrokerContext } from "../queries/health.js";
import { useBrokerFilter, useRole } from "../scope/broker-scope.js";

// F9-T18: el calendario de lo programado y lo publicado, con posts y avisos, por semana o por mes,
// siempre en hora de Chile. Mover la fecha de una programada usa `POST /publications/:id/schedule`
// (el caso de uso de F6) con el selector de programar, que en vivo pide confirmar.

/** La grilla de días (una semana o las semanas del mes), con lo de cada día. */
export function CalendarGrid({
  view,
  anchor,
  today,
  entries,
  onOpenDay,
}: {
  view: CalendarView;
  anchor: string;
  today: string;
  entries: readonly CalendarEntryView[];
  onOpenDay: (day: string, trigger: HTMLElement) => void;
}) {
  const days = visibleDays(view, anchor);
  const byDay = byChileDay(entries);
  const month = anchor.slice(0, 7);
  return (
    <div className="mt-4">
      <div aria-hidden="true" className="hidden grid-cols-7 gap-2 md:grid">
        {WEEKDAYS.map((weekday) => (
          <p key={weekday} className="px-1 text-xs font-semibold text-fg-subtle uppercase">
            {weekday.slice(0, 3)}
          </p>
        ))}
      </div>
      <ol className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-7">
        {days.map((day) => {
          const items = byDay.get(day) ?? [];
          const { shown, more } = capDay(items);
          const outside = view === "mes" && !day.startsWith(month);
          // En el teléfono, la vista mensual muestra solo los días con algo (una lista por día).
          const hideOnPhone = items.length === 0 ? "hidden md:block" : "";
          return (
            <li
              key={day}
              aria-label={dayLabel(day)}
              className={`min-w-0 rounded-lg border p-1.5 ${view === "semana" ? "md:min-h-56" : "md:min-h-36"} ${
                day === today ? "border-info-500 bg-info-50" : "border-line bg-canvas"
              } ${outside ? "opacity-60" : ""} ${view === "mes" ? hideOnPhone : ""}`}
            >
              <p
                className={`text-xs font-semibold ${day === today ? "text-info-800" : "text-fg-muted"}`}
              >
                <span className="md:hidden">{dayLabel(day)}</span>
                <span className="hidden md:inline">{Number(day.slice(8))}</span>
              </p>
              {items.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {shown.map((entry) => (
                    <CalendarChip
                      key={entry.publicationId}
                      entry={entry}
                      onOpen={(trigger) => onOpenDay(day, trigger)}
                    />
                  ))}
                  {more > 0 && (
                    <li>
                      <button
                        type="button"
                        onClick={(event) => onOpenDay(day, event.currentTarget)}
                        aria-label={`${more} más el ${dayLabel(day)}: ver todo el día`}
                        className="w-full rounded-md border border-dashed border-line-strong px-1.5 py-1 text-left text-xs font-semibold text-brand-800 hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-700"
                      >
                        +{more} más
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const FILTERS_KEY = "agentsales.calendar.filters";

/** Los filtros del calendario, recordados en este navegador (si no se puede guardar, igual funcionan). */
function useEntryFilters(): [EntryFilters, (next: EntryFilters) => void] {
  const [filters, setFilters] = useState<EntryFilters>(() => {
    try {
      return parseEntryFilters(localStorage.getItem(FILTERS_KEY));
    } catch {
      return DEFAULT_ENTRY_FILTERS;
    }
  });
  const update = (next: EntryFilters) => {
    setFilters(next);
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch {
      // Sin almacenamiento (ventana privada, datos bloqueados): la elección vale hasta recargar.
    }
  };
  return [filters, update];
}

/** Un interruptor de filtro: dice qué agrega y cuántas hay. */
export function FilterChip({
  label,
  count,
  pressed,
  onToggle,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium pointer-coarse:min-h-11 ${
        pressed
          ? "border-brand-700 bg-brand-50 text-brand-900"
          : "border-line-strong bg-surface text-fg-muted hover:border-brand-700"
      }`}
    >
      <span aria-hidden="true">{pressed ? "✓" : "○"}</span>
      {label}
      <span className="text-xs text-fg-subtle">({count})</span>
    </button>
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
      className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <h2 className="text-base font-semibold">Mover la fecha</h2>
      <p className="mt-1 text-sm text-fg-muted">
        {PLATFORM_TEXT[entry.platform]}{" "}
        {publicationFormatText(entry.platform, entry.format, entry.mediaCount)} de{" "}
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
  // El modo de la marca de cada entrada (F9.5-T22, ADR-0036), no el del servidor.
  const modeOf = useBrokerModeOf();
  const calendar = useCalendar(rangeOfDays(visibleDays(view, anchor)), broker);
  const [moving, setMoving] = useState<CalendarEntryView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useEntryFilters();
  const [openDay, setOpenDay] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeDay = () => {
    setOpenDay(null);
    opener.current?.focus();
  };

  const { shown, counts } = applyEntryFilters(calendar.data ?? [], filters);
  const showBroker = role === "admin" && broker === undefined;
  const hidden = (filters.retired ? 0 : counts.retired) + (filters.failed ? 0 : counts.failed);

  const go = (next: { vista?: CalendarView; dia?: string }) => {
    setOpenDay(null);
    const search = new URLSearchParams(params);
    if (next.vista !== undefined) search.set("vista", next.vista);
    if (next.dia !== undefined) search.set("dia", next.dia);
    setParams(search);
  };

  return (
    <section className="mx-auto max-w-6xl">
      <PageHeader
        title="Calendario"
        description={
          <>Lo programado y lo publicado, de propiedades y posts. Las horas son de Chile.</>
        }
      />
      {/* Al llegar su hora, una publicación deja de estar programada: si falló, espera tu
          confirmación o quedó con resultado dudoso, sale de aquí y se resuelve en Seguimiento. */}
      <p className="mt-1 text-sm text-fg-muted">
        Lo que falló, espera tu confirmación o quedó con resultado dudoso está en{" "}
        <Link
          to="/seguimiento"
          className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
        >
          Seguimiento
        </Link>
        .
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <fieldset className="flex gap-1">
          <legend className="sr-only">Vista</legend>
          {(["semana", "mes"] as const).map((option) => (
            <Button
              key={option}
              aria-pressed={view === option}
              variant={view === option ? "primary" : "secondary"}
              size="sm"
              onClick={() => go({ vista: option })}
            >
              {option === "semana" ? "Semana" : "Mes"}
            </Button>
          ))}
        </fieldset>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => go({ dia: shiftAnchor(view, anchor, -1) })}
          >
            {view === "semana" ? "Semana anterior" : "Mes anterior"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => go({ dia: today })}>
            Hoy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => go({ dia: shiftAnchor(view, anchor, 1) })}
          >
            {view === "semana" ? "Semana siguiente" : "Mes siguiente"}
          </Button>
        </div>
      </div>
      <h2 className="mt-4 text-lg font-semibold">{periodLabel(view, anchor)}</h2>

      {notice !== null && (
        <p role="status" className="mt-2 text-sm text-success-800">
          {notice}
        </p>
      )}
      {moving !== null && (
        <SubjectBrokerContext.Provider value={moving.brokerId}>
          <MovePanel
            entry={moving}
            publishMode={modeOf(moving.brokerId)}
            onDone={(at) => {
              setMoving(null);
              setNotice(`Quedó programada para el ${formatChileTime(at)} (hora de Chile).`);
            }}
            onCancel={() => setMoving(null)}
          />
        </SubjectBrokerContext.Provider>
      )}
      {calendar.error && (
        <ErrorAlert
          error={calendar.error}
          onRetry={() => void calendar.refetch()}
          retrying={calendar.isFetching}
        />
      )}
      {calendar.isPending && <p className="mt-2 text-sm text-fg-muted">Cargando el calendario…</p>}
      {calendar.data && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <FilterChip
              label="Retiradas y descartadas"
              count={counts.retired}
              pressed={filters.retired}
              onToggle={() => setFilters({ ...filters, retired: !filters.retired })}
            />
            <FilterChip
              label="Fallidas y dudosas"
              count={counts.failed}
              pressed={filters.failed}
              onToggle={() => setFilters({ ...filters, failed: !filters.failed })}
            />
            <p role="status" className="text-sm text-fg-muted">
              {hidden > 0
                ? `${hidden === 1 ? "1 oculta" : `${hidden} ocultas`} por los filtros.`
                : "Sin nada oculto."}
            </p>
          </div>
          <p className="mt-2 text-xs text-fg-subtle">
            <span aria-hidden="true">✓</span> publicada · <span aria-hidden="true">◷</span>{" "}
            programada · <span aria-hidden="true">!</span> atrasada o te toca ·{" "}
            <span aria-hidden="true">✕</span> falló · <span aria-hidden="true">?</span> no se sabe
            si salió · <span aria-hidden="true">⊘</span> retirada o descartada. Los borradores y las
            ideas no se ven aquí: están en Contenido.
          </p>
          {shown.length === 0 && (
            <p className="mt-2 text-sm text-fg-muted">
              {calendar.data.length === 0
                ? "Nada programado ni publicado en estas fechas."
                : "Nada a la vista con estos filtros."}
            </p>
          )}
          {openDay !== null && (
            <DayPanel
              day={openDay}
              entries={byChileDay(shown).get(openDay) ?? []}
              showBroker={showBroker}
              onClose={closeDay}
              onMove={(entry) => {
                setNotice(null);
                setMoving(entry);
              }}
            />
          )}
          <CalendarGrid
            view={view}
            anchor={anchor}
            today={today}
            entries={shown}
            onOpenDay={(day, trigger) => {
              opener.current = trigger;
              setOpenDay(day);
            }}
          />
        </>
      )}
    </section>
  );
}
