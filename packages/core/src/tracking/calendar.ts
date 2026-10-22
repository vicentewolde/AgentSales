import type { Language, Platform, PublicationFormat, PublicationStatus } from "../enums.js";
import type { Listing } from "../listing.js";
import type { Post } from "../post.js";
import type { Publication } from "../publication.js";
import { type ScheduleState, scheduleState } from "../schedule.js";

// El calendario del panel (spec F9 §5, F9-T18): lo programado y lo ya publicado de posts y avisos
// en un rango de fechas, en una sola lista por hora. Puro: la ruta carga los avisos y posts del
// alcance y sus publicaciones (`listForTracking`), y aquí se arman las entradas.

/** El rango más largo que se pide de una vez: seis semanas (la vista mensual) y el cambio de hora. */
export const CALENDAR_MAX_RANGE_MS = 43 * 24 * 60 * 60 * 1000;

/**
 * Qué marca la fecha de una entrada: `scheduled`, la hora programada (se puede mover); `published`,
 * la hora en que salió (solo se mira).
 */
export const CALENDAR_ENTRY_KINDS = ["scheduled", "published"] as const;
export type CalendarEntryKind = (typeof CALENDAR_ENTRY_KINDS)[number];

export type CalendarEntry = {
  publicationId: string;
  kind: CalendarEntryKind;
  /** La hora programada o la de publicación. */
  at: Date;
  platform: Platform;
  format: PublicationFormat;
  language: Language;
  status: PublicationStatus;
  dryRun: boolean;
  /** Los medios fijos de la publicación (un `post` de Instagram con uno es una imagen). */
  mediaCount: number;
  /** En qué está una programada (`upcoming`, `due`, `overdue`); `null` en una publicada. */
  schedule: ScheduleState | null;
  /** El aviso (`null` en un post). */
  listingId: string | null;
  /** El post (`null` en un aviso). */
  postId: string | null;
  /** El `id_propiedad` del aviso o el tema del post (como la agenda). */
  title: string;
  brokerId: string;
  /** Solo `https` (el panel lo vuelve enlace). */
  externalUrl: string | null;
};

export type CalendarInput = {
  listings: readonly Pick<Listing, "id" | "brokerId" | "externalRef">[];
  posts: readonly Pick<Post, "id" | "brokerId" | "topic">[];
  publications: readonly Publication[];
  /** El rango `[from, to)`. */
  from: Date;
  to: Date;
  now: Date;
};

const httpsOrNull = (url: string | null) => (url?.startsWith("https://") ? url : null);

/** La hora que la pone en el calendario, o `null` si no va (ni programada ni publicada). */
function placed(publication: Publication): { kind: CalendarEntryKind; at: Date } | null {
  if (publication.status === "scheduled" && publication.scheduledAt !== null) {
    return { kind: "scheduled", at: publication.scheduledAt };
  }
  if (publication.publishedAt !== null) return { kind: "published", at: publication.publishedAt };
  return null;
}

/**
 * Las entradas del calendario (`calendarEntries`, pura): cada publicación `scheduled` por su hora
 * programada y cada una que ya salió (`publishedAt`) por esa hora, dentro de `[from, to)`. Solo las
 * de los avisos y posts recibidos (el alcance de la sesión): las de otro sujeto se ignoran. Ordenadas
 * por hora, después título y red.
 */
export function calendarEntries(input: CalendarInput): CalendarEntry[] {
  // El título y el corredor de cada sujeto del alcance.
  const listings = new Map(
    input.listings.map((l) => [l.id, { title: l.externalRef, brokerId: l.brokerId }]),
  );
  const posts = new Map(input.posts.map((p) => [p.id, { title: p.topic, brokerId: p.brokerId }]));
  const entries: CalendarEntry[] = [];
  for (const publication of input.publications) {
    const where = placed(publication);
    if (where === null) continue;
    if (where.at.getTime() < input.from.getTime() || where.at.getTime() >= input.to.getTime()) {
      continue;
    }
    const { subject } = publication;
    const owner = subject.kind === "listing" ? listings.get(subject.id) : posts.get(subject.id);
    if (owner === undefined) continue;
    entries.push({
      publicationId: publication.id,
      kind: where.kind,
      at: where.at,
      platform: publication.platform,
      format: publication.format,
      language: publication.language,
      status: publication.status,
      dryRun: publication.dryRun,
      mediaCount: publication.mediaIds.length,
      schedule: scheduleState(publication, input.now),
      listingId: subject.kind === "listing" ? subject.id : null,
      postId: subject.kind === "post" ? subject.id : null,
      title: owner.title,
      brokerId: owner.brokerId,
      externalUrl: httpsOrNull(publication.externalUrl),
    });
  }
  return entries.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      a.title.localeCompare(b.title, "es") ||
      a.platform.localeCompare(b.platform) ||
      a.publicationId.localeCompare(b.publicationId),
  );
}
