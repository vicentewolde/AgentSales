import {
  formatChileTime,
  LISTING_PLATFORMS,
  type ListingPlatform,
  MAX_SCHEDULE_SPACING_MINUTES,
  PLATFORM_TEXT,
  type PublishMode,
} from "@agentsales/core";
import { useId, useState } from "react";
import { useScheduleListings } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";
import { ScheduleForm } from "./ScheduleForm.js";

// F6-T12 (spec F6 §4.3): programar varias propiedades de una vez desde la lista.

/**
 * El lote: los canales (ninguno marcado = cada canal con texto aprobado y cuenta conectada), la
 * hora de Chile y el espaciado entre propiedades. El resultado viene por propiedad y canal: una que
 * no se pudo programar no corta las demás.
 */
export function BatchSchedule({
  selected,
  publishMode,
  onClear,
}: {
  selected: readonly { id: string; externalRef: string }[];
  publishMode: PublishMode | undefined;
  onClear: () => void;
}) {
  const schedule = useScheduleListings();
  const spacingId = useId();
  const [open, setOpen] = useState(false);
  const [platforms, setPlatforms] = useState<ListingPlatform[]>([]);
  const [spacing, setSpacing] = useState("0");
  const refOf = new Map(selected.map((listing) => [listing.id, listing.externalRef]));
  const spacingMinutes = Number(spacing);
  const spacingValid =
    Number.isInteger(spacingMinutes) &&
    spacingMinutes >= 0 &&
    spacingMinutes <= MAX_SCHEDULE_SPACING_MINUTES;

  const toggle = (platform: ListingPlatform, on: boolean) =>
    setPlatforms((current) =>
      on ? [...current, platform] : current.filter((value) => value !== platform),
    );

  return (
    <section
      aria-label="Programar seleccionadas"
      className="mt-4 rounded-xl border border-brand-200 bg-brand-50/60 p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold text-brand-800">{selected.length} seleccionada(s)</span>
        {!open && (
          <Button
            size="sm"
            onClick={() => {
              schedule.reset();
              setOpen(true);
            }}
          >
            Programar seleccionadas
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClear}>
          Quitar selección
        </Button>
      </div>
      {open && (
        <ScheduleForm
          // Cambiar los canales o el espaciado vuelve a pedir la confirmación en vivo.
          key={`${[...platforms].sort().join(",")}-${spacing}`}
          publishMode={publishMode}
          pending={schedule.isPending}
          submitLabel={`Programar ${selected.length} propiedad(es)`}
          extra={
            <>
              <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
                <legend className="mb-2 font-medium text-fg">
                  Canales (sin marcar: todos los que tengan texto aprobado)
                </legend>
                {LISTING_PLATFORMS.map((platform) => (
                  <label key={platform} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={platforms.includes(platform)}
                      onChange={(event) => toggle(platform, event.target.checked)}
                    />
                    {PLATFORM_TEXT[platform]}
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-col gap-1">
                <label htmlFor={spacingId} className="font-medium text-fg">
                  Minutos entre una propiedad y la siguiente
                </label>
                <Input
                  id={spacingId}
                  type="number"
                  width="auto"
                  min={0}
                  max={MAX_SCHEDULE_SPACING_MINUTES}
                  value={spacing}
                  onChange={(event) => setSpacing(event.target.value)}
                  className="w-24 tabular-nums"
                />
                {!spacingValid && (
                  <p className="font-medium text-danger-700">
                    Un número de minutos entre 0 y {MAX_SCHEDULE_SPACING_MINUTES}.
                  </p>
                )}
              </div>
            </>
          }
          onSubmit={(at) => {
            if (!spacingValid) return;
            schedule.mutate(
              {
                listingIds: selected.map((listing) => listing.id),
                at,
                ...(platforms.length === 0 ? {} : { platforms }),
                ...(spacingMinutes === 0 ? {} : { spacingMinutes }),
              },
              { onSuccess: () => setOpen(false) },
            );
          }}
          onCancel={() => setOpen(false)}
        />
      )}
      {schedule.error && <ErrorAlert error={schedule.error} />}
      {schedule.data && (
        <div role="status" className="mt-3 text-sm">
          <ul className="space-y-1">
            {schedule.data.results.map((row) => {
              const name = `${refOf.get(row.listingId) ?? row.listingId}${row.platform === null ? "" : ` · ${PLATFORM_TEXT[row.platform]}`}`;
              return (
                <li
                  key={`${row.listingId}-${row.platform ?? "todo"}`}
                  className={row.outcome === "scheduled" ? "text-fg" : "text-warning-800"}
                >
                  {row.outcome === "scheduled"
                    ? `${name}: programada para el ${row.at === undefined ? "" : formatChileTime(row.at)}`
                    : `${name}: no se programó (${row.message ?? row.code ?? ""})`}
                </li>
              );
            })}
          </ul>
          {schedule.data.notes.map((note) => (
            <p key={note} className="mt-1 text-warning-800">
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
