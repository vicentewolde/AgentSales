import type { ListingListResponse, ListingQuery } from "@agentsales/api/contracts";
import {
  formatListingPrice,
  LISTING_STATUS_TEXT,
  LISTING_STATUSES,
  OPERATION_TEXT,
  OPERATIONS,
} from "@agentsales/core";
import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { BatchSchedule } from "../components/publications/BatchSchedule.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Field, Select } from "../components/ui/Field.js";
import { HomeIcon } from "../components/ui/icons.js";
import { HomeIllustration } from "../components/ui/illustrations.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Loading } from "../components/ui/Spinner.js";
import { useHealth } from "../queries/health.js";
import { useListings } from "../queries/listings.js";
import { useBrokerFilter } from "../scope/broker-scope.js";

type ListingItem = ListingListResponse["listings"][number];

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((candidate) => candidate === value);

/** Filtros desde la URL (`?status=ready&comuna=Ñuñoa`); un valor desconocido se ignora. */
export function filtersFrom(params: URLSearchParams): ListingQuery {
  const status = oneOf(LISTING_STATUSES, params.get("status"));
  const operation = oneOf(OPERATIONS, params.get("operation"));
  const comuna = params.get("comuna")?.trim() || undefined;
  return {
    ...(status ? { status } : {}),
    ...(operation ? { operation } : {}),
    ...(comuna ? { comuna } : {}),
  };
}

function FilterSelect({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (name: string, value: string) => void;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} className="min-w-40 flex-1 sm:flex-none">
      <Select id={id} value={value} onChange={(event) => onChange(name, event.target.value)}>
        <option value="">Todos</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function ListingCard({
  listing,
  selected,
  onSelect,
}: {
  listing: ListingItem;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const title = [listing.propertyType ?? "Propiedad", listing.comuna].filter(Boolean).join(" · ");
  return (
    <li className="relative">
      {/* Fuera del enlace: un control dentro de un enlace no se puede usar con el teclado. */}
      <label className="absolute top-3 left-3 z-10 flex size-11 cursor-pointer items-center justify-center rounded-full bg-surface/95 shadow-sm">
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Seleccionar ${listing.externalRef} para programar`}
          onChange={(event) => onSelect(event.target.checked)}
          className="size-4.5"
        />
      </label>
      {/* F9.5-T26: la foto de portada es la protagonista; el precio va en serif. */}
      <Link
        to={`/propiedades/${listing.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-2xl bg-surface shadow-card transition hover:shadow-lift"
      >
        <div className="relative aspect-[4/3] overflow-hidden bg-sand">
          {listing.coverUrl ? (
            <img
              src={listing.coverUrl}
              alt={`Portada de ${listing.externalRef}`}
              loading="lazy"
              className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-fg-muted">
              <HomeIllustration className="w-28" />
              <span>Sin foto</span>
            </div>
          )}
          <span className="absolute top-3.5 right-3.5">
            <StatusBadge status={listing.status} />
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1 px-5 pt-4 pb-5">
          <span className="text-xs font-medium tracking-wide tabular-nums text-fg-subtle">
            {listing.externalRef}
          </span>
          <p className="font-display text-[1.625rem] leading-tight text-fg tabular-nums">
            {formatListingPrice(listing)}
          </p>
          <p className="text-[1.0625rem] font-semibold text-fg">{title}</p>
          <div className="mt-auto pt-2">
            <p className="border-t border-line pt-2.5 text-sm text-fg-subtle">
              {listing.operation ? OPERATION_TEXT[listing.operation] : "Sin operación"}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Propiedades: grilla con portada y filtros en la URL (spec F1-T13). */
export function ListingsPage() {
  const [params, setParams] = useSearchParams();
  // El corredor del selector (el administrador, F7-T17) se suma a los filtros de la URL.
  const broker = useBrokerFilter();
  const filters = { ...filtersFrom(params), ...(broker === undefined ? {} : { broker }) };
  const listings = useListings(filters);
  const health = useHealth();
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  // Otro corredor en el selector: lo marcado era del anterior.
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con el cambio de corredor.
  useEffect(() => setSelected(new Map()), [broker]);
  const select = (listing: ListingItem, on: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(listing.id, listing.externalRef);
      else next.delete(listing.id);
      return next;
    });
  // Las comunas del selector salen de todas las propiedades (es la misma consulta sin filtros); si
  // esa consulta falla, de las que se ven.
  const all = useListings(broker === undefined ? {} : { broker });
  const comunas = [
    ...new Set([
      ...(all.data ?? listings.data ?? []).flatMap((listing) =>
        listing.comuna ? [listing.comuna] : [],
      ),
      ...(filters.comuna ? [filters.comuna] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b, "es"));

  const setFilter = (name: string, value: string) => {
    // Lo marcado que el filtro ocultaría no se programa sin verlo.
    setSelected(new Map());
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === "") next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  };
  // Los filtros de la página (no el corredor del selector, que se quita en el menú).
  const filtered = Object.keys(filtersFrom(params)).length > 0;

  return (
    <section>
      <PageHeader
        title="Propiedades"
        description="Tus avisos con su portada, su estado y su precio. Marca varias para programarlas juntas."
      />

      <form
        aria-label="Filtros"
        className="flex flex-wrap items-end gap-3 rounded-3xl bg-surface p-4 shadow-md sm:px-5"
        onSubmit={(event) => event.preventDefault()}
      >
        <FilterSelect
          label="Estado"
          name="status"
          value={filters.status ?? ""}
          options={LISTING_STATUSES.map((status) => ({
            value: status,
            label: LISTING_STATUS_TEXT[status],
          }))}
          onChange={setFilter}
        />
        <FilterSelect
          label="Operación"
          name="operation"
          value={filters.operation ?? ""}
          options={OPERATIONS.map((operation) => ({
            value: operation,
            label: OPERATION_TEXT[operation],
          }))}
          onChange={setFilter}
        />
        <FilterSelect
          label="Comuna"
          name="comuna"
          value={filters.comuna ?? ""}
          options={comunas.map((comuna) => ({ value: comuna, label: comuna }))}
          onChange={setFilter}
        />
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(new Map());
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Quitar filtros
          </Button>
        )}
      </form>

      {listings.error && (
        <ErrorAlert
          error={listings.error}
          onRetry={() => void listings.refetch()}
          retrying={listings.isFetching}
        />
      )}

      {/* Lo que cambia al filtrar se anuncia a los lectores de pantalla. */}
      <div aria-live="polite">
        {listings.isPending && (
          <div className="mt-6">
            <Loading>Cargando propiedades…</Loading>
          </div>
        )}
        {listings.data?.length === 0 && (
          <div className="mt-6">
            <EmptyState
              icon={<HomeIcon className="size-5" />}
              title={
                filtered
                  ? "No hay propiedades con esos filtros."
                  : broker !== undefined
                    ? "Este corredor todavía no tiene propiedades."
                    : "Todavía no hay propiedades."
              }
              {...(filtered || broker !== undefined
                ? {}
                : {
                    description: (
                      <>
                        Cárgalas con:{" "}
                        <code className="rounded-md bg-sand px-1.5 py-0.5 text-xs text-fg">
                          pnpm -s cli import propiedades.xlsx --media medios
                        </code>
                      </>
                    ),
                  })}
            />
          </div>
        )}
        {listings.data && listings.data.length > 0 && (
          <p className="mt-5 text-sm text-fg-muted tabular-nums">
            {listings.data.length} propiedad(es)
            {listings.isPlaceholderData && " · actualizando…"}
          </p>
        )}
      </div>

      {selected.size > 0 && (
        <BatchSchedule
          selected={[...selected].map(([id, externalRef]) => ({ id, externalRef }))}
          publishMode={health.data?.publishMode}
          onClear={() => setSelected(new Map())}
        />
      )}

      {listings.data && listings.data.length > 0 && (
        <ul
          aria-label="Resultados"
          className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-6"
        >
          {listings.data.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              selected={selected.has(listing.id)}
              onSelect={(on) => select(listing, on)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
