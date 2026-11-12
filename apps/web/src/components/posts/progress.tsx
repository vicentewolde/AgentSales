import type { TrackingResponse } from "@agentsales/api/contracts";
import { Badge } from "../ui/Badge.js";
import type { BadgeTone } from "../ui/styles.js";

/** La fila de un post en Seguimiento: de ahí sale en qué va cada post (publicado, programado…). */
export type TrackingPostRow = TrackingResponse["posts"][number];

/**
 * En qué va un post según sus publicaciones (una por red e idioma), en una sola palabra:
 * - `published`: todo lo que se pidió salió.
 * - `partial`: salió una parte; falta lo demás.
 * - `scheduled`: programado y todavía a tiempo.
 * - `overdue`: programado y su hora pasó sin salir.
 * - `waiting`: a mano; te toca publicar y confirmar.
 * - `failed`: falló o no se sabe si salió.
 * - `approved`: texto aprobado, pero sin hora.
 * - `none`: nada aprobado ni programado.
 */
export const POST_PROGRESS_STATES = [
  "published",
  "partial",
  "scheduled",
  "overdue",
  "waiting",
  "failed",
  "approved",
  "none",
] as const;
export type PostProgressState = (typeof POST_PROGRESS_STATES)[number];

export type PostProgress = {
  state: PostProgressState;
  /** La primera hora programada que viene, si hay. */
  nextAt: Date | null;
  /** Cuándo salió lo último que salió de verdad (hora de `publishedAt`), si algo salió. */
  publishedAt: Date | null;
};

/**
 * Una publicación simulada que quedó reemplazada por la real (`superseded_by_record`) queda
 * `unpublished` y en simulación: no es una retirada de verdad y no se muestra como tal.
 */
export const isSupersededSimulation = (pub: { status: string; dryRun: boolean }): boolean =>
  pub.status === "unpublished" && pub.dryRun;

/** Qué fecha se muestra de un post y cómo se llama, en palabras simples. */
export type PostWhen = {
  kind: "published" | "scheduled" | "planned";
  at: Date;
  label: string;
};

/**
 * La fecha que importa de un post: si salió, cuándo salió; si está programado, la próxima hora
 * programada; si no, la fecha planeada; `null` si no tiene ninguna.
 */
export function postWhen(plannedAt: Date | null, progress: PostProgress): PostWhen | null {
  if (progress.state === "published" && progress.publishedAt !== null) {
    return { kind: "published", at: progress.publishedAt, label: "Salió el" };
  }
  if (progress.nextAt !== null) {
    return { kind: "scheduled", at: progress.nextAt, label: "Programado para el" };
  }
  if (progress.publishedAt !== null && plannedAt === null) {
    return { kind: "published", at: progress.publishedAt, label: "Salió el" };
  }
  if (plannedAt !== null) return { kind: "planned", at: plannedAt, label: "Fecha planeada:" };
  return null;
}

/** Lo que dejó de contar: una publicación cancelada o retirada ya no es parte del post. */
const DEAD = new Set(["cancelled", "unpublished"]);

export function postProgress(row: TrackingPostRow | undefined): PostProgress {
  if (row === undefined) return { state: "none", nextAt: null, publishedAt: null };
  const all = Object.values(row.cells)
    .flat()
    .filter((pub) => !DEAD.has(pub.status));
  if (all.length === 0) return { state: "none", nextAt: null, publishedAt: null };
  const publishedPubs = all.filter((pub) => pub.status === "published");
  const published = publishedPubs.length;
  const publishedAt =
    publishedPubs
      .map((pub) => pub.publishedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const scheduled = all.filter((pub) => pub.status === "scheduled" || pub.status === "publishing");
  const nextAt =
    scheduled
      .map((pub) => pub.scheduledAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const state = ((): PostProgressState => {
    if (published === all.length) return "published";
    if (all.some((pub) => pub.status === "failed" || pub.status === "outcome_unknown")) {
      return "failed";
    }
    if (all.some((pub) => pub.status === "awaiting_manual_confirm")) return "waiting";
    if (scheduled.some((pub) => pub.schedule === "overdue")) return "overdue";
    if (published > 0) return "partial";
    if (scheduled.length > 0) return "scheduled";
    if (all.some((pub) => pub.status === "approved")) return "approved";
    return "none";
  })();
  return { state, nextAt, publishedAt };
}

/** El texto de cada estado, para una insignia. */
export const POST_PROGRESS_LABEL: Readonly<Record<PostProgressState, string>> = {
  published: "Publicado",
  partial: "Publicado en parte",
  scheduled: "Programado",
  overdue: "Atrasado: no salió a su hora",
  waiting: "Te toca publicarlo a mano",
  failed: "Falló: hay que mirarlo",
  approved: "Aprobado, sin hora",
  none: "Sin programar",
};

const PROGRESS_TONE: Readonly<Record<PostProgressState, BadgeTone>> = {
  published: "success",
  partial: "info",
  scheduled: "info",
  overdue: "danger",
  waiting: "warning",
  failed: "danger",
  approved: "neutral",
  none: "neutral",
};

/** Un post sin nada que ya salió ni vaya a salir a tiempo: su fecha pasada es una alerta. */
export const isStale = (
  plannedAt: Date | null,
  progress: PostProgress,
  now: Date = new Date(),
): boolean =>
  plannedAt !== null &&
  plannedAt.getTime() < now.getTime() &&
  progress.state !== "published" &&
  progress.state !== "scheduled" &&
  progress.state !== "waiting" &&
  progress.state !== "partial";

export function PostProgressBadge({ progress }: { progress: PostProgress }) {
  return <Badge tone={PROGRESS_TONE[progress.state]}>{POST_PROGRESS_LABEL[progress.state]}</Badge>;
}

/** «hoy», «hace 1 día», «hace 3 días»: cuánto pasó desde una fecha. */
export function daysAgoText(date: Date, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return "hoy, hace unas horas";
  return days === 1 ? "hace 1 día" : `hace ${days} días`;
}

/**
 * La alerta de una fecha que ya pasó sin que el post saliera, en una línea y con cuánto pasó. El
 * remedio largo va en la ayuda de la lista y en el detalle del post. En una idea (aún no es un
 * post) el remedio es otro: editar la fecha antes de aceptarla.
 */
export function StaleDateNote({
  plannedAt,
  className,
  idea = false,
}: {
  plannedAt: Date;
  className?: string;
  idea?: boolean;
}) {
  return (
    <p role="status" className={className}>
      <span className="inline-flex items-center gap-1.5 font-semibold text-warning-800">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 2.5 20h19z" />
          <path d="M12 10v4M12 17.2v.1" />
        </svg>
        Fecha pasada {daysAgoText(plannedAt)}
      </span>
      {idea && <span className="text-fg-muted"> · edítala antes de aceptar la idea</span>}
    </p>
  );
}
