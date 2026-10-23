import type { TrackingResponse } from "@agentsales/api/contracts";
import {
  AGENDA_KIND_TEXT,
  CHILE_TIME_ZONE,
  formatChileTime,
  LISTING_STATUS_TEXT,
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
import { daySummary, greetingLine, todayText } from "../components/agenda/today.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { PublicationMode } from "../components/publications/PublicationMode.js";
import { safeExternalUrl } from "../components/publications/publications.js";
import { Badge } from "../components/ui/Badge.js";
import { ButtonLink } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import {
  CalendarIcon,
  CheckCircleIcon,
  HomeIcon,
  InboxIcon,
  LinkIcon,
  PencilIcon,
} from "../components/ui/icons.js";
import { ArmchairIllustration, HomeIllustration } from "../components/ui/illustrations.js";
import { Loading } from "../components/ui/Spinner.js";
import { buttonClasses, cx } from "../components/ui/styles.js";
import { useMe } from "../queries/auth.js";
import { useBrokerPublishMode } from "../queries/brokers.js";
import { useAgenda, useTracking } from "../queries/tracking.js";
import { useBrokerFilter, useScopedBroker, useScopedBrokerKind } from "../scope/broker-scope.js";

// F9.5-T03 (spec F9.5, D11): la portada «Hoy». Tres bloques con lo que ya traen `GET /agenda` (lo
// que pide acción y lo programado a 7 días) y `GET /tracking` (lo publicado, por `publishedAt`),
// con el corredor del selector. Sin rutas nuevas; se relee cada 60 s con la pestaña a la vista.
// F9.5-T26: el saludo por nombre, la fecha, una frase con el resumen del día y la portada de una
// propiedad como bienvenida (o una ilustración de hogar), también desde esos dos pedidos.

const TITLE_LINK = "font-semibold text-fg underline-offset-2 hover:text-brand-900 hover:underline";

/** Las portadas de las propiedades por la ruta de su detalle (`/propiedades/<id>`). */
type Covers = ReadonlyMap<string, string>;

const coversOf = (tracking: TrackingResponse | undefined): Covers =>
  new Map(
    (tracking?.rows ?? []).flatMap((row) =>
      row.coverUrl === null ? [] : [[`/propiedades/${row.listing.id}`, row.coverUrl] as const],
    ),
  );

/** La miniatura de un ítem: la portada de la propiedad o un ícono de lo que es. Decorativa. */
function Thumb({ src, icon, size }: { src?: string; icon: ReactNode; size: "md" | "sm" }) {
  const box = size === "md" ? "size-20 rounded-2xl" : "size-13 rounded-xl";
  return src === undefined ? (
    <span
      aria-hidden="true"
      className={cx(box, "grid shrink-0 place-items-center bg-brand-50 text-brand-800")}
    >
      {icon}
    </span>
  ) : (
    <img src={src} alt="" loading="lazy" className={cx(box, "shrink-0 object-cover")} />
  );
}

const itemIcon = (item: AgendaItem) =>
  item.postId !== null ? (
    <PencilIcon className="size-6" />
  ) : item.listingId !== null ? (
    <HomeIcon className="size-6" />
  ) : (
    <LinkIcon className="size-6" />
  );

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
  return text === "" ? null : <span className="block text-sm text-fg-subtle">{text}</span>;
}

/** La red del ítem con su formato («Instagram · reel»), o nada si no es de una red. */
const itemChannel = (item: AgendaItem): string | null =>
  item.platform === null
    ? null
    : platformWithFormat(item.platform, item.format, item.mediaCount, PLATFORM_TEXT[item.platform]);

function TodoEntry({ item, covers }: { item: AgendaItem; covers: Covers }) {
  const when =
    item.kind === "backup"
      ? item.at === null
        ? "nunca se respaldó"
        : `último respaldo ${formatChileTime(item.at)}`
      : agendaItemWhen(item);
  const path = agendaItemPath(item);
  const cover = path === null ? undefined : covers.get(path);
  return (
    <li className="flex gap-4 rounded-2xl bg-surface p-4 shadow-md">
      <Thumb src={cover} icon={itemIcon(item)} size="md" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <Badge tone={AGENDA_KIND_TONE[item.kind]}>{AGENDA_KIND_TEXT[item.kind]}</Badge>
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
            <span className="block text-xs font-medium text-brand-800">
              {AGENDA_ACTION_TEXT[item.action]}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

const DAY = new Intl.DateTimeFormat("es-CL", { timeZone: CHILE_TIME_ZONE, day: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat("es-CL", { timeZone: CHILE_TIME_ZONE, weekday: "short" });

/** El día del mes y de la semana, como en una agenda de papel. Decorativo: la fecha va al lado. */
function DayMark({ at }: { at: Date | null }) {
  return (
    <span aria-hidden="true" className="w-12 shrink-0 text-center text-xs text-fg-subtle">
      {at !== null && (
        <>
          <span className="block font-display text-xl leading-tight text-fg">{DAY.format(at)}</span>
          {WEEKDAY.format(at).replace(".", "")}
        </>
      )}
    </span>
  );
}

function UpcomingEntry({ item }: { item: AgendaItem }) {
  return (
    <li className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <DayMark at={item.at} />
      <div className="min-w-0">
        <ItemTitle item={item} />
        <Details parts={[item.at === null ? null : formatChileTime(item.at), itemChannel(item)]} />
      </div>
    </li>
  );
}

function RecentEntry({
  publication,
  publishMode,
  covers,
}: {
  publication: RecentPublication;
  publishMode: PublishMode | undefined;
  covers: Covers;
}) {
  const url = safeExternalUrl(publication.externalUrl);
  return (
    <li className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <Link to={publication.path} className={TITLE_LINK}>
          {publication.title}
          {publication.kind === "post" && (
            <span className="font-normal text-fg-subtle"> (post)</span>
          )}
        </Link>
        <span className="block text-sm text-fg-subtle">
          {platformWithFormat(
            publication.platform,
            publication.format,
            publication.mediaCount,
            PLATFORM_TEXT[publication.platform],
          )}{" "}
          · {formatChileTime(publication.publishedAt)}
          <PublicationMode publication={publication} publishMode={publishMode} prefix=" · " />
        </span>
        <span className="mt-1.5 mr-3 inline-flex align-middle">
          <Badge tone="success">Publicada</Badge>
        </span>
        {url !== null && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-brand-800 underline-offset-2 hover:text-brand-900 hover:underline"
          >
            <LinkIcon className="size-4" />
            Ver en {PLATFORM_TEXT[publication.platform]}
          </a>
        )}
      </div>
      <Thumb
        src={covers.get(publication.path)}
        icon={
          publication.kind === "post" ? (
            <PencilIcon className="size-5" />
          ) : (
            <HomeIcon className="size-5" />
          )
        }
        size="sm"
      />
    </li>
  );
}

/** Una cifra del resumen de arriba. */
function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-2xl bg-surface/70 px-4 py-3 ring-1 ring-line ring-inset">
      <dt className="text-sm text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 font-display text-3xl text-fg">{value ?? "—"}</dd>
    </div>
  );
}

/** El cuerpo de un bloque: cargando, el error, el vacío o la lista. */
function Block<T>({
  query,
  items,
  empty,
  listClassName = "divide-y divide-line",
  children,
}: {
  query: { error: Error | null; isPending: boolean; isFetching: boolean; refetch: () => unknown };
  items: readonly T[] | undefined;
  empty: ReactNode;
  listClassName?: string;
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
  return <ul className={listClassName}>{children(items)}</ul>;
}

/** La imagen de bienvenida: la portada de una propiedad o una ilustración de hogar. */
function Welcome({ tracking, brand }: { tracking: TrackingResponse | undefined; brand: boolean }) {
  const row = tracking?.rows.find((candidate) => candidate.coverUrl !== null);
  const cover = row?.coverUrl ?? null;
  if (row !== undefined && cover !== null) {
    const name = [row.listing.propertyType ?? "Propiedad", row.listing.comuna]
      .filter(Boolean)
      .join(" en ");
    return (
      <figure className="relative m-0 min-h-64 overflow-hidden rounded-3xl bg-sand shadow-lift lg:min-h-72">
        <img src={cover} alt={name} className="absolute inset-0 h-full w-full object-cover" />
        <figcaption className="absolute bottom-4 left-4 max-w-[calc(100%-2rem)] truncate rounded-full bg-surface/95 px-3.5 py-2 text-sm text-fg">
          {name} · {LISTING_STATUS_TEXT[row.listing.status]}
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="m-0 flex min-h-64 flex-col items-center justify-center gap-3 rounded-3xl bg-sand px-6 py-8 text-center lg:min-h-72">
      <HomeIllustration className="w-52 max-w-full" />
      {tracking !== undefined && !brand && (
        <figcaption className="max-w-xs text-sm text-fg-muted">
          Cuando cargues una propiedad con fotos, su portada te da la bienvenida aquí.
        </figcaption>
      )}
    </figure>
  );
}

/** La portada (F9.5-T03): lo que te toca, lo próximo y lo publicado hace poco. */
export function HomePage() {
  const broker = useBrokerFilter();
  const agenda = useAgenda(broker);
  const tracking = useTracking(false, broker);
  const brand = useScopedBrokerKind() === "brand";
  const name = useMe().data?.name;
  // El modo de la marca elegida (F9.5-T22, ADR-0036), para `PublicationMode` (D4 del spec F9.5):
  // con «Todos» y el servidor en vivo no se sabe de qué marca es, y no se dice.
  const publishMode = useBrokerPublishMode(useScopedBroker()?.id);
  const now = new Date();

  const todo = agenda.data?.filter(needsAction);
  const upcoming = agenda.data
    ?.filter((item) => item.kind === "upcoming")
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  const recent = tracking.data === undefined ? undefined : recentPublications(tracking.data, now);
  const covers = coversOf(tracking.data);
  const phrase = daySummary(todo?.length, upcoming?.length);

  return (
    <section>
      <header className="mb-10 grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-stretch">
        <div className="flex flex-col justify-center gap-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5 text-fg-subtle">
            <h1 className="text-xl font-semibold text-brand-800">Hoy</h1>
            <span aria-hidden="true">·</span>
            <span className="text-[0.9375rem]">{todayText(now)}</span>
          </div>
          <p className="font-display text-[2.5rem] leading-[1.05] text-fg sm:text-[3.25rem]">
            {greetingLine(now, name)}
          </p>
          {phrase !== null && <p className="max-w-md text-lg text-fg-muted">{phrase}</p>}
          <div className="mt-2 flex flex-wrap gap-3">
            {todo !== undefined && todo.length > 0 && (
              <a href="#te-toca" className={buttonClasses("primary")}>
                Revisar lo que te toca
              </a>
            )}
            {!brand && (
              <ButtonLink to="/importar" variant="secondary">
                Cargar propiedades
              </ButtonLink>
            )}
          </div>
        </div>
        <Welcome tracking={tracking.data} brand={brand} />
      </header>

      <dl className="mb-10 grid gap-3 sm:grid-cols-3">
        <Figure label="Te toca" value={todo?.length ?? null} />
        <Figure label="Próximas (7 días)" value={upcoming?.length ?? null} />
        <Figure label="Publicadas en 7 días" value={recent?.length ?? null} />
      </dl>

      <section id="te-toca" aria-labelledby="hoy-te-toca" className="mb-10 scroll-mt-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="hoy-te-toca" className="text-[1.625rem] font-semibold text-fg">
            Te toca
          </h2>
          <p className="text-sm text-fg-subtle">Lo que espera algo de ti.</p>
        </div>
        <Block
          query={agenda}
          items={todo}
          listClassName="grid gap-4 md:grid-cols-2"
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
                covers={covers}
              />
            ))
          }
        </Block>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
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
                illustration={<ArmchairIllustration className="w-36" />}
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
                  covers={covers}
                />
              ))
            }
          </Block>
        </Card>
      </div>
    </section>
  );
}
