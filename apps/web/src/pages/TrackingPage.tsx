import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import {
  AGENDA_KIND_TEXT,
  AGENDA_KINDS,
  type AgendaAction,
  CLOSE_REASON_TEXT,
  formatChileTime,
  LISTING_PLATFORMS,
  PLATFORM_TEXT,
  type Platform,
  type PublishMode,
  publicationFormatText,
} from "@agentsales/core";
import { useState } from "react";
import { Link } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { PublicationMode } from "../components/publications/PublicationMode.js";
import { safeExternalUrl } from "../components/publications/publications.js";
import { PublicationStatusBadge, StatusBadge } from "../components/StatusBadge.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useHealth } from "../queries/health.js";
import { useAgenda, useTracking } from "../queries/tracking.js";
import { useBrokerFilter } from "../scope/broker-scope.js";

// F6-T13 (spec F6 §4.9): la agenda arriba y la matriz abajo. Se relee cada 60 s solo con la
// pestaña a la vista (ADR-0007).

type AgendaItem = AgendaResponse["items"][number];
type Row = TrackingResponse["rows"][number];
type Cell = Row["cells"]["instagram"][number];

/** Qué hacer con cada ítem, en el panel (la CLI muestra el comando). */
const ACTION_TEXT: Readonly<Record<AgendaAction, string>> = {
  publish: "Publícala desde Contenido",
  reschedule: "Reprográmala",
  requeue: "Retómala desde Contenido",
  retry: "Reintenta desde Contenido",
  retire: "Bórrala en la plataforma y márcala como retirada",
  review: "Revisa y aprueba el texto en Contenido",
  relist: "Republícala desde Contenido",
  sync: "Usa Actualizar en Contenido para leer su estado",
  // F9-T08 y T17: lo de los posts (en su página de Contenido) y las cuentas.
  resolve: "Revisa la red y di si salió o no desde el post, en Contenido",
  confirm: "Publícala a mano en la red y confirma con el enlace desde el post, en Contenido",
  reconnect: "Vuelve a conectar la cuenta en Cuentas",
  backup:
    "En el Mac, corre pnpm db:backup en tu terminal; en el servidor lo hace el worker al encenderse y a las 13:00 (el error está en sus logs)",
  none: "",
};

function itemWhen(item: AgendaItem): string | null {
  if (item.at === null) return null;
  if (item.kind === "expiring" || item.kind === "token_expiring") {
    return item.expired
      ? `venció el ${formatChileTime(item.at)}`
      : `vence en ${item.daysLeft} ${item.daysLeft === 1 ? "día" : "días"}`;
  }
  return formatChileTime(item.at);
}

function AgendaEntry({
  item,
  publishMode,
}: {
  item: AgendaItem;
  publishMode: PublishMode | undefined;
}) {
  if (item.kind === "backup") {
    return (
      <li className="text-sm">
        Último respaldo: {item.at === null ? "nunca" : formatChileTime(item.at)}
        {item.stale && <span className="ml-1 text-warning-800">(más de 48 h)</span>}
        {item.code !== null && (
          <span className="ml-1 text-warning-800">· el último intento falló ({item.code})</span>
        )}
        {item.action !== "none" && (
          <span className="block text-xs text-fg-muted">{ACTION_TEXT[item.action]}</span>
        )}
      </li>
    );
  }
  const channel =
    item.platform === null
      ? null
      : `${PLATFORM_TEXT[item.platform]}${item.format === null ? "" : ` ${publicationFormatText(item.platform, item.format, item.mediaCount)}`}`;
  const when = itemWhen(item);
  return (
    <li className="text-sm">
      {item.postId !== null ? (
        // Un post, con su tema: su página de Contenido (F9-T17).
        <Link
          to={`/contenido/${item.postId}`}
          className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
        >
          {item.title ?? item.externalRef}
          <span className="font-normal text-fg-subtle"> (post)</span>
        </Link>
      ) : item.listingId === null ? (
        // Una cuenta (con su nombre): sin página propia.
        <span className="font-semibold">{item.title ?? item.externalRef}</span>
      ) : (
        <Link
          to={`/propiedades/${item.listingId}`}
          className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
        >
          {item.externalRef}
        </Link>
      )}
      {channel && <> · {channel}</>}
      {when && <> · {when}</>}
      {item.dryRun !== null && (
        <PublicationMode
          publication={{ dryRun: item.dryRun, modeFixed: item.modeFixed }}
          publishMode={publishMode}
          prefix=" · "
        />
      )}
      {/* El consejo dice qué hacer; el código va aparte, chico, para quien lo busque. */}
      {item.advice !== null && <span className="block text-fg-muted">{item.advice}</span>}
      {item.code !== null && (
        <span className="block text-xs text-fg-subtle">código {item.code}</span>
      )}
      {item.action !== "none" && (
        <span className="block text-xs text-fg-muted">{ACTION_TEXT[item.action]}</span>
      )}
    </li>
  );
}

/** La agenda en su orden (`AGENDA_KINDS`), una sección por clase. */
export function Agenda({
  items,
  publishMode,
}: {
  items: readonly AgendaItem[];
  /** El modo del sistema: lo aprobado sin publicar dice el suyo (D4 del spec F9.5). */
  publishMode?: PublishMode | undefined;
}) {
  const groups = AGENDA_KINDS.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
  if (groups.length === 0) return <p className="mt-2 text-sm text-fg-muted">Nada pendiente.</p>;
  return (
    <div className="mt-2 space-y-4">
      {groups.map((group) => (
        <section key={group.kind} aria-label={AGENDA_KIND_TEXT[group.kind]}>
          <h3 className="text-sm font-semibold text-fg">
            {AGENDA_KIND_TEXT[group.kind]} ({group.items.length})
          </h3>
          <ul className="mt-1 space-y-2">
            {group.items.map((item) => (
              <AgendaEntry
                key={`${item.kind}-${item.publicationId ?? item.listingId ?? "x"}-${item.platform ?? ""}`}
                item={item}
                publishMode={publishMode}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CellPublication({
  platform,
  publication,
  publishMode,
}: {
  platform: Platform;
  publication: Cell;
  publishMode: PublishMode | undefined;
}) {
  const notes = [
    publication.schedule === "overdue" ? "atrasada" : null,
    publication.scheduledAt !== null && publication.status === "scheduled"
      ? formatChileTime(publication.scheduledAt)
      : null,
    publication.manualTask ? "tarea a mano" : null,
    publication.expiry?.soon ? `vence en ${publication.expiry.daysLeft} d` : null,
    publication.expiry?.expired ? "venció" : null,
    publication.lastError === null ? null : publication.lastError.message,
    publication.lastError === null ? null : `código ${publication.lastError.code}`,
  ].filter(Boolean);
  return (
    <li>
      {publicationFormatText(platform, publication.format, publication.mediaCount)}{" "}
      <PublicationStatusBadge status={publication.status} />
      <PublicationMode
        publication={publication}
        publishMode={publishMode}
        liveOnly
        className="ml-1 text-xs"
      />
      {notes.length > 0 && <span className="block text-xs text-fg-muted">{notes.join(" · ")}</span>}
      {safeExternalUrl(publication.externalUrl) !== null && (
        <a
          href={safeExternalUrl(publication.externalUrl) ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="block text-xs text-info-700 underline"
        >
          Ver
        </a>
      )}
    </li>
  );
}

/** La matriz: una fila por propiedad, una columna por plataforma. */
export function TrackingMatrix({
  rows,
  publishMode,
}: {
  rows: readonly Row[];
  publishMode?: PublishMode | undefined;
}) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-fg-muted">Sin propiedades.</p>;
  return (
    <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col">Propiedad</th>
            {LISTING_PLATFORMS.map((platform) => (
              <th key={platform} scope="col">
                {PLATFORM_TEXT[platform]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.listing.id}>
              <th scope="row" className="font-normal">
                <Link
                  to={`/propiedades/${row.listing.id}`}
                  className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
                >
                  {row.listing.externalRef}
                </Link>
                <span className="block">
                  <StatusBadge status={row.listing.status} />
                  {row.listing.closeReason !== null && (
                    <span className="ml-1 text-xs text-fg-muted">
                      {CLOSE_REASON_TEXT[row.listing.closeReason]}
                    </span>
                  )}
                </span>
              </th>
              {LISTING_PLATFORMS.map((platform) => (
                <td key={platform}>
                  {row.cells[platform].length === 0 ? (
                    <span className="text-fg-subtle">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {row.cells[platform].map((publication) => (
                        <CellPublication
                          key={publication.id}
                          platform={platform}
                          publication={publication}
                          publishMode={publishMode}
                        />
                      ))}
                    </ul>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Seguimiento (spec F6 §4.9): la agenda y la matriz. */
export function TrackingPage() {
  const [archived, setArchived] = useState(false);
  const broker = useBrokerFilter();
  const agenda = useAgenda(broker);
  const tracking = useTracking(archived, broker);
  const publishMode = useHealth().data?.publishMode;
  return (
    <section className="mx-auto max-w-6xl">
      <PageHeader title="Seguimiento" />

      <section aria-labelledby="agenda-titulo" className="mt-4">
        <h2 id="agenda-titulo" className="text-lg font-semibold">
          Agenda
        </h2>
        {agenda.error && (
          <ErrorAlert
            error={agenda.error}
            onRetry={() => void agenda.refetch()}
            retrying={agenda.isFetching}
          />
        )}
        {agenda.isPending && <p className="mt-2 text-sm text-fg-muted">Cargando la agenda…</p>}
        {agenda.data && <Agenda items={agenda.data} publishMode={publishMode} />}
      </section>

      <section aria-labelledby="matriz-titulo" className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="matriz-titulo" className="text-lg font-semibold">
            Propiedades por plataforma
          </h2>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            Mostrar archivadas
          </label>
        </div>
        {tracking.error && (
          <ErrorAlert
            error={tracking.error}
            onRetry={() => void tracking.refetch()}
            retrying={tracking.isFetching}
          />
        )}
        {tracking.isPending && <p className="mt-2 text-sm text-fg-muted">Cargando…</p>}
        {tracking.data && <TrackingMatrix rows={tracking.data} publishMode={publishMode} />}
      </section>
    </section>
  );
}
