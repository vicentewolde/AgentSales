import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import {
  type AgendaAction,
  type AgendaKind,
  formatChileTime,
  LISTING_PLATFORMS,
  type Platform,
  POST_PLATFORMS,
  type PublicationFormat,
  publicationFormatText,
  workerScheduleText,
} from "@agentsales/core";
import type { BadgeTone } from "../ui/styles.js";

// Lo que comparten la agenda de Seguimiento y la portada «Hoy» (F9.5-T03): qué hacer con cada
// ítem, su hora, adónde lleva y qué entra en cada bloque de la portada.

export type AgendaItem = AgendaResponse["items"][number];

/** Qué hacer con cada ítem, en el panel (la CLI muestra el comando). */
export const AGENDA_ACTION_TEXT: Readonly<Record<AgendaAction, string>> = {
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
  // F9.5-T24 (ADR-0037): con horario, la próxima revisión lo enciende (el horario sale de core);
  // sin horario, hay que encenderlo.
  wait_worker: `Sale cuando se encienda el worker, en la próxima revisión del horario (${workerScheduleText()}). Para que salga ya: en el servidor, GitHub → Actions → «Encender el worker» → Run workflow; en el Mac, pnpm dev`,
  start_worker:
    "Sin horario, el worker debe estar encendido: enciéndelo (en el servidor, GitHub → Actions → «Encender el worker» → Run workflow; en el Mac, pnpm dev)",
  backup:
    "En el Mac, corre pnpm db:backup en tu terminal; en el servidor lo hace el worker al encenderse y a las 13:00 (el error está en sus logs)",
  none: "",
};

/** El tono de la insignia de cada clase de la agenda (el texto, `AGENDA_KIND_TEXT`, dice cuál es). */
export const AGENDA_KIND_TONE: Readonly<Record<AgendaKind, BadgeTone>> = {
  worker_off: "warning",
  overdue: "danger",
  your_turn: "warning",
  outcome_unknown: "warning",
  stuck: "warning",
  failed: "danger",
  manual_task: "warning",
  // «Espera tu revisión» en el tono de atención (F9.5-T26).
  needs_review: "warning",
  approved_waiting: "brand",
  token_expiring: "warning",
  expiring: "warning",
  upcoming: "info",
  backup: "warning",
};

/**
 * La red con su formato, «Instagram · carrusel» (F9.5-T20): un aviso o un post de Instagram sale
 * como carrusel, reel o imagen; sin formato (un ítem que no es de una publicación), solo la red.
 */
export function platformWithFormat(
  platform: Platform,
  format: PublicationFormat | null,
  mediaCount: number | null,
  platformText: string,
): string {
  return format === null
    ? platformText
    : `${platformText} · ${publicationFormatText(platform, format, mediaCount)}`;
}

/** La hora del ítem, en Chile: la programada, la del cambio, o cuánto le queda si vence. */
export function agendaItemWhen(item: AgendaItem): string | null {
  if (item.at === null) return null;
  if (item.kind === "expiring" || item.kind === "token_expiring") {
    return item.expired
      ? `venció el ${formatChileTime(item.at)}`
      : `vence en ${item.daysLeft} ${item.daysLeft === 1 ? "día" : "días"}`;
  }
  return formatChileTime(item.at);
}

/**
 * Adónde lleva el ítem: el post (Contenido), la propiedad, Cuentas (un token por vencer) o Estado
 * (el respaldo, del administrador).
 */
export function agendaItemPath(item: AgendaItem): string | null {
  if (item.postId !== null) return `/contenido/${item.postId}`;
  if (item.listingId !== null) return `/propiedades/${item.listingId}`;
  if (item.kind === "token_expiring") return "/cuentas";
  if (item.kind === "backup") return "/estado";
  return null;
}

/**
 * «Te toca» en la portada: lo de la agenda que pide una acción. Fuera quedan las próximas (otro
 * bloque) y el respaldo cuando está al día.
 */
export const needsAction = (item: AgendaItem): boolean =>
  item.kind !== "upcoming" && !(item.kind === "backup" && item.action === "none");

/** Lo publicado hace poco: cuántos días mira la portada y cuántas muestra. */
export const RECENT_DAYS = 7;
export const RECENT_LIMIT = 8;

export type RecentPublication = {
  id: string;
  /** El `id_propiedad` o el tema del post. */
  title: string;
  /** La propiedad o el post. */
  path: string;
  kind: "listing" | "post";
  platform: Platform;
  /** El formato y el número de medios: «carrusel», «reel» o «imagen» (F9.5-T20). */
  format: PublicationFormat;
  mediaCount: number | null;
  publishedAt: Date;
  externalUrl: string | null;
  /** El modo de la publicación (una publicada lo tiene fijado: D4 del spec F9.5). */
  dryRun: boolean;
  modeFixed: boolean;
};

/**
 * Las publicaciones publicadas en los últimos `RECENT_DAYS` días (por `publishedAt`), de avisos y
 * posts, la más reciente primero. Todas: la portada cuenta el total y muestra `RECENT_LIMIT`.
 */
export function recentPublications(tracking: TrackingResponse, now: Date): RecentPublication[] {
  const since = now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const out: RecentPublication[] = [];
  type Cell = TrackingResponse["rows"][number]["cells"]["instagram"][number];
  const collect = <P extends Platform>(
    platforms: readonly P[],
    cells: Readonly<Record<P, readonly Cell[]>>,
    base: Pick<RecentPublication, "title" | "path" | "kind">,
  ) => {
    for (const platform of platforms) {
      for (const publication of cells[platform]) {
        const at = publication.publishedAt;
        if (publication.status !== "published" || at === null || at.getTime() < since) continue;
        out.push({
          ...base,
          id: publication.id,
          platform,
          format: publication.format,
          mediaCount: publication.mediaCount,
          publishedAt: at,
          externalUrl: publication.externalUrl,
          dryRun: publication.dryRun,
          modeFixed: publication.modeFixed,
        });
      }
    }
  };
  for (const row of tracking.rows) {
    collect(LISTING_PLATFORMS, row.cells, {
      title: row.listing.externalRef,
      path: `/propiedades/${row.listing.id}`,
      kind: "listing",
    });
  }
  for (const row of tracking.posts) {
    collect(POST_PLATFORMS, row.cells, {
      title: row.post.topic,
      path: `/contenido/${row.post.id}`,
      kind: "post",
    });
  }
  return out.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}
