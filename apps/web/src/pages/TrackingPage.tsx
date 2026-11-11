import type { TrackingResponse } from "@agentsales/api/contracts";
import {
  AGENDA_KIND_TEXT,
  AGENDA_KINDS,
  CLOSE_REASON_TEXT,
  formatChileDayTime,
  formatChileTime,
  LANGUAGE_TEXT,
  LISTING_PLATFORMS,
  PLATFORM_TEXT,
  type Platform,
  POST_PLATFORMS,
  type PostPlatform,
  type PublishMode,
  publicationFormatText,
} from "@agentsales/core";
import { useState } from "react";
import { Link } from "react-router";
import {
  AGENDA_ACTION_TEXT,
  type AgendaItem,
  agendaItemWhen,
  isHandTask,
} from "../components/agenda/agenda.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { errorLineText } from "../components/error-messages.js";
import { HandTask } from "../components/posts/HandTask.js";
import { HAND_LABEL } from "../components/posts/hand.js";
import { CONFIRMED_WITHOUT_LINK_TEXT, confirmedWithoutLink } from "../components/posts/linkedin.js";
import {
  isSupersededSimulation,
  PostProgressBadge,
  postProgress,
  postWhen,
} from "../components/posts/progress.js";
import { PublicationMode } from "../components/publications/PublicationMode.js";
import { safeExternalUrl } from "../components/publications/publications.js";
import { PublicationStatusBadge, StatusBadge } from "../components/StatusBadge.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useBrokerModeOf, useBrokers } from "../queries/brokers.js";
import { useAgenda, useTracking } from "../queries/tracking.js";
import { useBrokerFilter, useScopedBroker } from "../scope/broker-scope.js";

// F6-T13 (spec F6 §4.9): la agenda arriba y la matriz abajo. Se relee cada 60 s solo con la
// pestaña a la vista (ADR-0007).

type Row = TrackingResponse["rows"][number];
type PostRow = TrackingResponse["posts"][number];
type Cell = Row["cells"]["instagram"][number];

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
          <span className="block text-xs text-fg-muted">{AGENDA_ACTION_TEXT[item.action]}</span>
        )}
      </li>
    );
  }
  const channel =
    item.platform === null
      ? null
      : `${PLATFORM_TEXT[item.platform]}${item.format === null ? "" : ` ${publicationFormatText(item.platform, item.format, item.mediaCount)}`}`;
  const when = agendaItemWhen(item);
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
        <span className="block text-xs text-fg-muted">{AGENDA_ACTION_TEXT[item.action]}</span>
      )}
      {/* A mano (LinkedIn, X o Instagram): «<Red>: publica a mano» con el botón de un clic. */}
      {isHandTask(item) && (
        <div className="mt-1">
          <span className="font-semibold text-fg">{HAND_LABEL[item.platform]}: publica a mano</span>
          <HandTask
            platform={item.platform}
            postId={item.postId}
            publicationId={item.publicationId}
            mode={{ dryRun: item.dryRun, modeFixed: item.modeFixed }}
            publishMode={publishMode}
          />
        </div>
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
    confirmedWithoutLink({ platform, ...publication }) ? CONFIRMED_WITHOUT_LINK_TEXT : null,
    publication.expiry?.soon ? `vence en ${publication.expiry.daysLeft} d` : null,
    publication.expiry?.expired ? "venció" : null,
    // En simple, con el código chico al final (F9.5-T20).
    publication.lastError === null ? null : errorLineText(publication.lastError),
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
  modeOf,
}: {
  rows: readonly Row[];
  publishMode?: PublishMode | undefined;
  /** El modo de la marca de cada fila (F9.5-T22): manda sobre `publishMode`. */
  modeOf?: (brokerId: string) => PublishMode | undefined;
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
                  {row.cells[platform].filter((publication) => !isSupersededSimulation(publication))
                    .length === 0 ? (
                    <span className="text-fg-subtle">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {row.cells[platform]
                        .filter((publication) => !isSupersededSimulation(publication))
                        .map((publication) => (
                          <CellPublication
                            key={publication.id}
                            platform={platform}
                            publication={publication}
                            publishMode={modeOf ? modeOf(row.listing.brokerId) : publishMode}
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

/** Una publicación de un post en su celda: idioma, estado, cuándo salió y el enlace de lo publicado. */
function PostCellPublication({
  platform,
  publication,
  publishMode,
}: {
  platform: Platform;
  publication: Cell;
  publishMode: PublishMode | undefined;
}) {
  const url = safeExternalUrl(publication.externalUrl);
  const notes = [
    publication.schedule === "overdue" ? "atrasada" : null,
    publication.scheduledAt !== null && publication.status === "scheduled"
      ? `para el ${formatChileDayTime(publication.scheduledAt)}`
      : null,
    publication.manualTask ? "tarea a mano" : null,
    confirmedWithoutLink({ platform, ...publication }) ? CONFIRMED_WITHOUT_LINK_TEXT : null,
    publication.lastError === null ? null : errorLineText(publication.lastError),
  ].filter(Boolean);
  return (
    <li>
      <span className="text-xs font-semibold uppercase text-fg-muted">{publication.language}</span>{" "}
      <PublicationStatusBadge status={publication.status} />
      <PublicationMode
        publication={publication}
        publishMode={publishMode}
        liveOnly
        className="ml-1 text-xs"
      />
      {publication.status === "published" && publication.publishedAt !== null && (
        <span className="block text-xs text-fg-muted tabular-nums">
          Salió el {formatChileDayTime(publication.publishedAt)}
        </span>
      )}
      {notes.length > 0 && <span className="block text-xs text-fg-muted">{notes.join(" · ")}</span>}
      {url !== null && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Ver lo publicado en ${PLATFORM_TEXT[platform]} (${LANGUAGE_TEXT[publication.language]})`}
          className="block text-xs text-info-700 underline"
        >
          Ver lo publicado
        </a>
      )}
    </li>
  );
}

/**
 * Los posts por red: una fila por post con su avance y la fecha que importa (cuándo salió, la hora
 * programada o la planeada), y una celda por red con cada texto (idioma), su estado y el enlace. Lo
 * simulado que un registro real reemplazó no se muestra como «retirada».
 */
export function TrackingPosts({
  posts,
  modeOf,
  brandOf,
}: {
  posts: readonly PostRow[];
  modeOf?: (brokerId: string) => PublishMode | undefined;
  /** La marca de cada post, cuando se mira más de una. */
  brandOf?: (brokerId: string) => string | null;
}) {
  if (posts.length === 0) return <p className="mt-2 text-sm text-fg-muted">Sin posts.</p>;
  const entries = posts
    .map((row) => {
      const progress = postProgress(row);
      return { row, progress, when: postWhen(row.post.plannedAt, progress) };
    })
    .sort(
      (a, b) =>
        (b.when?.at.getTime() ?? Number.NEGATIVE_INFINITY) -
        (a.when?.at.getTime() ?? Number.NEGATIVE_INFINITY),
    );
  // Solo las redes donde algún post tiene algo: las demás vacías solo ensanchan la tabla.
  const visible = (platform: PostPlatform) => (row: PostRow) =>
    row.cells[platform].some(
      (publication) => !isSupersededSimulation(publication) && publication.status !== "cancelled",
    );
  const columns = POST_PLATFORMS.filter((platform) => posts.some(visible(platform)));
  return (
    <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col">Post</th>
            {columns.map((platform) => (
              <th key={platform} scope="col">
                {PLATFORM_TEXT[platform]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(({ row, progress, when }) => {
            const brand = brandOf?.(row.post.brokerId) ?? null;
            return (
              <tr key={row.post.id}>
                <th scope="row" className="min-w-48 font-normal">
                  <Link
                    to={`/contenido/${row.post.id}`}
                    className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
                  >
                    {row.post.topic}
                  </Link>
                  <span className="mt-1 block">
                    <PostProgressBadge progress={progress} />
                  </span>
                  <span className="mt-1 block text-xs text-fg-muted tabular-nums">
                    {when === null ? "Sin fecha" : `${when.label} ${formatChileDayTime(when.at)}`}
                  </span>
                  {brand !== null && <span className="block text-xs text-fg-subtle">{brand}</span>}
                </th>
                {columns.map((platform) => {
                  const shown = row.cells[platform].filter(
                    (publication) =>
                      !isSupersededSimulation(publication) && publication.status !== "cancelled",
                  );
                  return (
                    <td key={platform}>
                      {shown.length === 0 ? (
                        <span className="text-fg-subtle">—</span>
                      ) : (
                        <ul className="space-y-2">
                          {shown.map((publication) => (
                            <PostCellPublication
                              key={publication.id}
                              platform={platform}
                              publication={publication}
                              publishMode={modeOf?.(row.post.brokerId)}
                            />
                          ))}
                        </ul>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Seguimiento (spec F6 §4.9): la agenda, los posts por red y las propiedades por plataforma. Con
 * posts a la vista van primero; las propiedades quedan debajo, plegadas, y sin ocupar sitio si el
 * corredor elegido no tiene ninguna.
 */
export function TrackingPage() {
  const [archived, setArchived] = useState(false);
  const broker = useBrokerFilter();
  const agenda = useAgenda(broker);
  const tracking = useTracking(archived, broker);
  const brokers = useBrokers();
  // El modo de la marca (F9.5-T22, ADR-0036): en la agenda, el de la marca elegida (con «Todos» y
  // el servidor en vivo no se dice); en la matriz, el de la marca de cada propiedad.
  const modeOf = useBrokerModeOf();
  const publishMode = modeOf(useScopedBroker()?.id);
  const postRows = tracking.data?.posts ?? [];
  const listingRows = tracking.data?.rows ?? [];
  const brandOf =
    broker === undefined
      ? (brokerId: string) => brokers.data?.find((b) => b.id === brokerId)?.brandName ?? null
      : undefined;
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

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 id="posts-titulo" className="text-lg font-semibold">
          Posts por red{tracking.data ? ` (${postRows.length})` : ""}
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
      {tracking.data && (
        <section aria-labelledby="posts-titulo">
          <TrackingPosts posts={postRows} modeOf={modeOf} {...(brandOf ? { brandOf } : {})} />
        </section>
      )}

      {listingRows.length > 0 ? (
        // Plegable: las propiedades no tapan a los posts; abierta solo si no hay posts.
        <details className="group mt-8" open={postRows.length === 0}>
          <summary className="cursor-pointer">
            <h2 className="inline text-lg font-semibold">
              Propiedades por plataforma ({listingRows.length})
            </h2>
          </summary>
          <TrackingMatrix rows={listingRows} modeOf={modeOf} />
        </details>
      ) : (
        tracking.data && (
          <p className="mt-6 text-sm text-fg-muted">
            {broker === undefined ? "No hay propiedades." : "Este corredor no tiene propiedades."}
          </p>
        )
      )}
    </section>
  );
}
