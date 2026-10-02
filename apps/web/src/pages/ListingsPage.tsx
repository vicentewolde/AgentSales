import type { ListingListResponse, ListingQuery } from "@agentsales/api/contracts";
import {
  formatListingPrice,
  LISTING_STATUS_TEXT,
  LISTING_STATUSES,
  OPERATION_TEXT,
  OPERATIONS,
} from "@agentsales/core";
import { useId } from "react";
import { Link, useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useListings } from "../queries/listings.js";

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
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-slate-600">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
      >
        <option value="">Todos</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ListingCard({ listing }: { listing: ListingItem }) {
  const title = [listing.propertyType ?? "Propiedad", listing.comuna].filter(Boolean).join(" · ");
  return (
    <li>
      <Link
        to={`/propiedades/${listing.id}`}
        className="block h-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
      >
        <div className="aspect-[4/3] bg-slate-100">
          {listing.coverUrl ? (
            <img
              src={listing.coverUrl}
              alt={`Portada de ${listing.externalRef}`}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              Sin foto
            </div>
          )}
        </div>
        <div className="p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">{listing.externalRef}</span>
            <StatusBadge status={listing.status} />
          </div>
          <p className="mt-1 font-semibold">{title}</p>
          <p className="mt-1 text-sm text-slate-600">
            {listing.operation ? OPERATION_TEXT[listing.operation] : "Sin operación"}
          </p>
          <p className="mt-2 text-lg font-semibold">{formatListingPrice(listing)}</p>
        </div>
      </Link>
    </li>
  );
}

/** Propiedades: grilla con portada y filtros en la URL (spec F1-T13). */
export function ListingsPage() {
  const [params, setParams] = useSearchParams();
  const filters = filtersFrom(params);
  const listings = useListings(filters);
  // Las comunas del selector salen de todas las propiedades (es la misma consulta sin filtros); si
  // esa consulta falla, de las que se ven.
  const all = useListings({});
  const comunas = [
    ...new Set([
      ...(all.data ?? listings.data ?? []).flatMap((listing) =>
        listing.comuna ? [listing.comuna] : [],
      ),
      ...(filters.comuna ? [filters.comuna] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b, "es"));

  const setFilter = (name: string, value: string) => {
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
  const filtered = Object.keys(filters).length > 0;

  return (
    <section className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold tracking-tight">Propiedades</h1>

      <form
        aria-label="Filtros"
        className="mt-4 flex flex-wrap items-end gap-3"
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
          <button
            type="button"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
            className="rounded-md px-2 py-1.5 text-sm text-slate-700 underline"
          >
            Quitar filtros
          </button>
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
        {listings.isPending && <p className="mt-6 text-slate-600">Cargando propiedades…</p>}
        {listings.data?.length === 0 && (
          <p className="mt-6 text-slate-600">
            {filtered
              ? "No hay propiedades con esos filtros."
              : "Todavía no hay propiedades. Cárgalas con: pnpm -s cli import propiedades.xlsx --media medios"}
          </p>
        )}
        {listings.data && listings.data.length > 0 && (
          <p className="mt-4 text-sm text-slate-600">
            {listings.data.length} propiedad(es)
            {listings.isPlaceholderData && " · actualizando…"}
          </p>
        )}
      </div>

      {listings.data && listings.data.length > 0 && (
        <ul aria-label="Resultados" className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.data.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </ul>
      )}
    </section>
  );
}
