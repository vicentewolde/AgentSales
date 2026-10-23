import {
  AGENDA_KIND_TEXT,
  formatChileTime,
  PLATFORM_TEXT,
  type PublishMode,
} from "@agentsales/core";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  AGENDA_ACTION_TEXT,
  AGENDA_KIND_TONE,
  type AgendaItem,
  agendaItemPath,
  agendaItemWhen,
  needsAction,
  platformWithFormat,
  RECENT_DAYS,
  RECENT_LIMIT,
  type RecentPublication,
  recentPublications,
} from "../components/agenda/agenda.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { PublicationMode } from "../components/publications/PublicationMode.js";
import { safeExternalUrl } from "../components/publications/publications.js";
import { Badge } from "../components/ui/Badge.js";
import { ButtonLink } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { CalendarIcon, CheckCircleIcon, InboxIcon, LinkIcon } from "../components/ui/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Loading } from "../components/ui/Spinner.js";
import { useBrokerPublishMode } from "../queries/brokers.js";
import { useAgenda, useTracking } from "../queries/tracking.js";
import { useBrokerFilter, useScopedBroker } from "../scope/broker-scope.js";

// F9.5-T03 (spec F9.5, D11): la portada «Hoy». Tres bloques con lo que ya traen `GET /agenda` (lo
// que pide acción y lo programado a 7 días) y `GET /tracking` (lo publicado, por `publishedAt`),
// con el corredor del selector. Sin rutas nuevas; se relee cada 60 s con la pestaña a la vista.

const TITLE_LINK = "font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline";

/** El título de un ítem de la agenda, con enlace a su detalle si tiene uno. */
function ItemTitle({ item }: { item: AgendaItem }) {
  const text =
    item.kind === "backup" ? "Respaldo de la base" : (item.title ?? item.externalRef ?? "—");
  const path = agendaItemPath(item);
  const suffix =
    item.postId !== null ? <span className="font-normal text-fg-subtle"> (post)</span> : null;
  return path === null ? (
    <span className="font-semibold text-fg">{text}</span>
  ) : (
    <Link to={path} className={TITLE_LINK}>
      {text}
      {suffix}
    </Link>
  );
}

/** Red y hora, separadas por un punto medio. */
function Details({ parts }: { parts: readonly (string | null)[] }) {
  const text = parts.filter((part): part is string => part !== null).join(" · ");
  return text === "" ? null : <span className="block text-sm text-fg-muted">{text}</span>;
}

/** La red del ítem con su formato («Instagram · reel»), o nada si no es de una red. */
const itemChannel = (item: AgendaItem): string | null =>
  item.platform === null
    ? null
    : platformWithFormat(item.platform, item.format, item.mediaCount, PLATFORM_TEXT[item.platform]);

function TodoEntry({ item }: { item: AgendaItem }) {
  const when =
    item.kind === "backup"
      ? item.at === null
        ? "nunca se respaldó"
        : `último respaldo ${formatChileTime(item.at)}`
      : agendaItemWhen(item);
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <ItemTitle item={item} />
        <Details parts={[itemChannel(item), when]} />
        {/* El consejo dice qué hacer; el código, solo si no hay consejo (como Seguimiento). */}
        {item.advice !== null ? (
          <span className="block text-sm text-fg-muted">{item.advice}</span>
        ) : (
          item.code !== null && (
            <span className="block text-sm text-danger-700">Error: {item.code}</span>
          )
        )}
        {item.action !== "none" && (
          <span className="block text-xs text-fg-subtle">{AGENDA_ACTION_TEXT[item.action]}</span>
        )}
      </div>
      <div className="shrink-0">
        <Badge tone={AGENDA_KIND_TONE[item.kind]}>{AGENDA_KIND_TEXT[item.kind]}</Badge>
      </div>
    </li>
  );
}

function UpcomingEntry({ item }: { item: AgendaItem }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <ItemTitle item={item} />
      <Details parts={[item.at === null ? null : formatChileTime(item.at), itemChannel(item)]} />
    </li>
  );
}

function RecentEntry({
  publication,
  publishMode,
}: {
  publication: RecentPublication;
  publishMode: PublishMode | undefined;
}) {
  const url = safeExternalUrl(publication.externalUrl);
  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <Link to={publication.path} className={TITLE_LINK}>
          {publication.title}
          {publication.kind === "post" && (
            <span className="font-normal text-fg-subtle"> (post)</span>
          )}
        </Link>
        <span className="block text-sm text-fg-muted">
          {platformWithFormat(
            publication.platform,
            publication.format,
            publication.mediaCount,
            PLATFORM_TEXT[publication.platform],
          )}{" "}
          · {formatChileTime(publication.publishedAt)}
          <PublicationMode publication={publication} publishMode={publishMode} prefix=" · " />
        </span>
      </div>
      {url !== null && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700 underline-offset-2 hover:text-brand-900 hover:underline"
        >
          <LinkIcon className="size-4" />
          Ver en {PLATFORM_TEXT[publication.platform]}
        </a>
      )}
    </li>
  );
}

/** Una cifra del resumen de arriba. */
function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-xs">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-fg">{value ?? "—"}</dd>
    </div>
  );
}

/** El cuerpo de un bloque: cargando, el error, el vacío o la lista. */
function Block<T>({
  query,
  items,
  empty,
  children,
}: {
  query: { error: Error | null; isPending: boolean; isFetching: boolean; refetch: () => unknown };
  items: readonly T[] | undefined;
  empty: ReactNode;
  children: (items: readonly T[]) => ReactNode;
}) {
  if (query.error !== null) {
    return (
      <ErrorAlert
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (query.isPending || items === undefined) return <Loading />;
  if (items.length === 0) return empty;
  return <ul className="divide-y divide-line">{children(items)}</ul>;
}

/** La portada (F9.5-T03): lo que te toca, lo próximo y lo publicado hace poco. */
export function HomePage() {
  const broker = useBrokerFilter();
  const agenda = useAgenda(broker);
  const tracking = useTracking(false, broker);
  // El modo de la marca elegida (F9.5-T22, ADR-0036), para `PublicationMode` (D4 del spec F9.5):
  // con «Todos» y el servidor en vivo no se sabe de qué marca es, y no se dice.
  const publishMode = useBrokerPublishMode(useScopedBroker()?.id);
  const now = new Date();

  const todo = agenda.data?.filter(needsAction);
  const upcoming = agenda.data
    ?.filter((item) => item.kind === "upcoming")
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  const recent = tracking.data === undefined ? undefined : recentPublications(tracking.data, now);

  return (
    <section>
      <PageHeader
        title="Hoy"
        description="Lo que te toca, lo que sale en los próximos días y lo que ya salió."
      />

      <dl className="mb-6 grid gap-3 sm:grid-cols-3">
        <Figure label="Te toca" value={todo?.length ?? null} />
        <Figure label="Próximas (7 días)" value={upcoming?.length ?? null} />
        <Figure label="Publicadas en 7 días" value={recent?.length ?? null} />
      </dl>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          as="section"
          title="Te toca"
          description="Lo que espera algo de ti."
          className="lg:col-span-2"
        >
          <Block
            query={agenda}
            items={todo}
            empty={
              <EmptyState
                icon={<CheckCircleIcon className="size-5" />}
                title="Nada pendiente"
                description="Cuando algo necesite tu revisión, una confirmación o un reintento, aparece aquí."
              />
            }
          >
            {(items) =>
              items.map((item) => (
                <TodoEntry
                  key={`${item.kind}-${item.publicationId ?? item.listingId ?? item.accountId ?? "x"}-${item.platform ?? ""}`}
                  item={item}
                />
              ))
            }
          </Block>
        </Card>

        <Card
          as="section"
          title="Próximas"
          description="Lo programado para los próximos 7 días, en hora de Chile."
          actions={
            <ButtonLink to="/calendario" variant="ghost" size="sm">
              Calendario
            </ButtonLink>
          }
        >
          <Block
            query={agenda}
            items={upcoming}
            empty={
              <EmptyState
                icon={<CalendarIcon className="size-5" />}
                title="Nada programado esta semana"
                description="Programa una publicación desde una propiedad o un post y aparece aquí."
              />
            }
          >
            {(items) =>
              items.map((item) => (
                <UpcomingEntry key={`${item.publicationId ?? item.listingId}`} item={item} />
              ))
            }
          </Block>
        </Card>

        <Card
          as="section"
          title="Publicado hace poco"
          description={`Lo que salió en los últimos ${RECENT_DAYS} días.`}
          actions={
            <ButtonLink to="/seguimiento" variant="ghost" size="sm">
              Seguimiento
            </ButtonLink>
          }
        >
          <Block
            query={tracking}
            items={recent?.slice(0, RECENT_LIMIT)}
            empty={
              <EmptyState
                icon={<InboxIcon className="size-5" />}
                title="Todavía nada esta semana"
                description="Lo que publiques aparece aquí, con el enlace a la red."
              />
            }
          >
            {(items) =>
              items.map((publication) => (
                <RecentEntry
                  key={publication.id}
                  publication={publication}
                  publishMode={publishMode}
                />
              ))
            }
          </Block>
        </Card>
      </div>
    </section>
  );
}
