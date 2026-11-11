import type { CalendarEntryView } from "@agentsales/api/contracts";
import {
  formatChileTime,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  PUBLICATION_STATUS_TEXT,
  publicationFormatText,
} from "@agentsales/core";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { PUBLICATION_STATUS_TONE } from "../../labels.js";
import { PublicationMode } from "../publications/PublicationMode.js";
import { safeExternalUrl } from "../publications/publications.js";
import { PublicationStatusBadge } from "../StatusBadge.js";
import { Button } from "../ui/Button.js";
import { BADGE_TONE, cx } from "../ui/styles.js";
import { dayLabel } from "./calendar.js";

// Las entradas del calendario: el chip compacto de la celda de un día y la ficha completa que se
// ve en el detalle del día (F9.5, pulido del calendario).

/** La hora de Chile de una entrada (`10:00`). */
export const timeOf = (entry: CalendarEntryView) => formatChileTime(entry.at).slice(11);

/**
 * La forma del estado, para que no dependa del color: ✓ publicada, ◷ programada, ! atrasada o
 * esperando al operador, ✕ falló, ? no se sabe, ⊘ retirada o descartada, … en curso.
 */
export function statusGlyph(entry: Pick<CalendarEntryView, "status" | "schedule">): string {
  if (entry.schedule === "overdue") return "!";
  switch (entry.status) {
    case "published":
      return "✓";
    case "scheduled":
    case "approved":
      return "◷";
    case "failed":
      return "✕";
    case "outcome_unknown":
      return "?";
    case "unpublished":
    case "cancelled":
      return "⊘";
    case "awaiting_manual_confirm":
      return "!";
    default:
      return "…";
  }
}

/** El estado en palabras (con «atrasada» si ya pasó su hora). */
export const statusWords = (entry: Pick<CalendarEntryView, "status" | "schedule">): string =>
  entry.schedule === "overdue"
    ? `${PUBLICATION_STATUS_TEXT[entry.status]}, atrasada`
    : PUBLICATION_STATUS_TEXT[entry.status];

export function EntryTitle({ entry }: { entry: CalendarEntryView }) {
  const to =
    entry.postId !== null
      ? `/contenido/${entry.postId}`
      : entry.listingId !== null
        ? `/propiedades/${entry.listingId}`
        : null;
  if (to === null) return <span className="font-semibold">{entry.title}</span>;
  return (
    <Link
      to={to}
      className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
    >
      {entry.title}
      {entry.postId !== null && <span className="font-normal text-fg-subtle"> (post)</span>}
    </Link>
  );
}

/**
 * Una entrada en la celda de su día: una línea con la forma del estado, la hora y la red, y el
 * título debajo. Al activarla se abre el detalle del día.
 */
export function CalendarChip({
  entry,
  onOpen,
}: {
  entry: CalendarEntryView;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const colors = BADGE_TONE[PUBLICATION_STATUS_TONE[entry.status]];
  const words = statusWords(entry);
  return (
    <li>
      <button
        type="button"
        onClick={(event) => onOpen(event.currentTarget)}
        aria-label={`${timeOf(entry)} ${PLATFORM_TEXT[entry.platform]} ${entry.title}, ${words}`}
        title={`${timeOf(entry)} ${PLATFORM_TEXT[entry.platform]} · ${words} · ${entry.title}`}
        className={cx(
          "block w-full min-w-0 rounded-md px-1.5 py-1 text-left text-xs leading-tight",
          "hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-700",
          colors.badge,
          entry.status === "unpublished" || entry.status === "cancelled"
            ? "line-through decoration-fg-subtle/60"
            : "",
        )}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className="w-3 shrink-0 text-center font-bold">
            {statusGlyph(entry)}
          </span>
          <span className="font-semibold">{timeOf(entry)}</span>
          <span className="min-w-0 truncate">{PLATFORM_TEXT[entry.platform]}</span>
        </span>
        <span className="block truncate pl-4 text-fg-muted">{entry.title}</span>
      </button>
    </li>
  );
}

/** Una publicación completa: hora, red y formato, estado, modo y título con enlace. */
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
      className="rounded-md border border-line bg-surface p-2 text-xs"
      aria-label={`${timeOf(entry)} ${PLATFORM_TEXT[entry.platform]} ${entry.title}`}
    >
      <p>
        <span className="font-semibold">{timeOf(entry)}</span> · {PLATFORM_TEXT[entry.platform]}{" "}
        {publicationFormatText(entry.platform, entry.format, entry.mediaCount)}
        {entry.postId !== null && <> · {LANGUAGE_TEXT[entry.language]}</>}
      </p>
      <p className="mt-0.5 break-words">
        <EntryTitle entry={entry} />
      </p>
      {showBroker && entry.brokerSlug !== null && (
        <p className="text-fg-subtle">{entry.brokerSlug}</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-1">
        <PublicationStatusBadge status={entry.status} />
        {entry.schedule === "overdue" && (
          <span className="font-semibold text-warning-800">atrasada</span>
        )}
        {/* Programada o ya publicada: su modo está fijado (D4 del spec F9.5). */}
        <PublicationMode
          publication={{ dryRun: entry.dryRun, modeFixed: true }}
          publishMode={undefined}
        />
      </p>
      <p className="mt-1 flex flex-wrap gap-2">
        {entry.kind === "scheduled" && (
          <Button variant="link" onClick={() => onMove(entry)}>
            Mover
          </Button>
        )}
        {url !== null && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
          >
            Ver
          </a>
        )}
      </p>
    </li>
  );
}

/**
 * El detalle de un día: todas sus entradas por hora, con sus enlaces. Al abrirse recibe el foco y
 * con Escape (o «Cerrar») se cierra y el foco vuelve a lo que lo abrió.
 */
export function DayPanel({
  day,
  entries,
  showBroker,
  onMove,
  onClose,
}: {
  day: string;
  entries: readonly CalendarEntryView[];
  showBroker: boolean;
  onMove: (entry: CalendarEntryView) => void;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con cambiar de día.
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [day]);
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="day-panel-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="day-panel-title"
          ref={heading}
          tabIndex={-1}
          className="text-base font-semibold outline-none"
        >
          {dayLabel(day)}
        </h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">Nada a la vista este día.</p>
      ) : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <CalendarItem
              key={entry.publicationId}
              entry={entry}
              showBroker={showBroker}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
