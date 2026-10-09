import type {
  PortalReadinessIssueView,
  PublicationEventView,
  PublicationView,
} from "@agentsales/api/contracts";
import {
  PLATFORM_TEXT,
  PUBLICATION_ACTOR_TEXT,
  PUBLICATION_STATUS_TEXT,
  PUBLISH_ATTEMPT_RESULT_TEXT,
  publicationFormatText,
  publicationModeText,
  publishAttemptPayloadSchema,
  remoteStatusText,
} from "@agentsales/core";
import type { Colors } from "../colors.js";
import { formatDate, formatDateTime, renderTable } from "../output.js";

/** Estado con color: verde publicada, rojo fallida, amarillo en curso, tenue lo cerrado. */
export function paintPublicationStatus(
  publication: Pick<PublicationView, "status">,
  c: Colors,
): string {
  const text = PUBLICATION_STATUS_TEXT[publication.status];
  if (publication.status === "published") return c.green(text);
  if (publication.status === "failed") return c.red(text);
  if (publication.status === "publishing" || publication.status === "approved")
    return c.yellow(text);
  return c.dim(text);
}

/** `carrusel de Instagram`, `aviso de Portal Inmobiliario`. */
export const publicationName = (publication: Pick<PublicationView, "format" | "platform">) =>
  `${publicationFormatText(publication.platform, publication.format)} de ${PLATFORM_TEXT[publication.platform]}`;

/** Un motivo de lo que le falta al aviso para Portal, con su columna del Excel: `  • Falta … (dormitorios)`. */
export const portalIssueLine = (issue: PortalReadinessIssueView) =>
  `  • ${issue.message}${issue.field === null ? "" : ` (${issue.field})`}`;

/** El estado en la plataforma (`remoteStatusText`), o nada si todavía no informó. */
const remoteText = (publication: Pick<PublicationView, "remoteState">) =>
  publication.remoteState === null ? "" : remoteStatusText(publication.remoteState);

/** El vencimiento del aviso en la plataforma (`stopTime`), o nada. */
const expiresText = (publication: Pick<PublicationView, "remoteState">) =>
  publication.remoteState?.stopTime == null
    ? ""
    : formatDate(new Date(publication.remoteState.stopTime));

/**
 * `En Mercado Libre: pausado por Mercado Libre · vence 2027-04-07`, y el motivo de la pausa si la
 * pausó Mercado Libre; nada si la plataforma todavía no informó (Instagram nunca lo hace).
 */
export function renderRemoteState(
  publication: Pick<PublicationView, "remoteState">,
  c: Colors,
): string[] {
  const status = remoteText(publication);
  if (status === "") return [];
  const expires = expiresText(publication);
  const reason = publication.remoteState?.reason;
  return [
    `En Mercado Libre: ${status}${expires === "" ? "" : ` · vence ${expires}`}`,
    ...(reason === undefined ? [] : [c.yellow(reason.message)]),
  ];
}

/** El enlace si salió; si falló, el motivo; si no, nada. */
const outcomeOf = (publication: PublicationView, c: Colors) => {
  if (publication.externalUrl !== null) return publication.externalUrl;
  if (publication.lastError !== null) {
    return c.red(`${publication.lastError.code}: ${publication.lastError.message}`);
  }
  return "";
};

/**
 * Tabla de publicaciones (spec F3 §4.9): id, canal, formato, estado, modo, intentos y enlace o
 * error. Si hay alguna de Portal suma su estado en Mercado Libre y el vencimiento (spec F4 §4.12), y
 * debajo, el motivo de las que pausó Mercado Libre.
 */
export function renderPublications(publications: readonly PublicationView[], c: Colors): string {
  const portal = publications.some(
    (publication) =>
      publication.platform === "portal_inmobiliario" || publication.remoteState !== null,
  );
  const table = renderTable(
    [
      "ID",
      "CANAL",
      "FORMATO",
      "ESTADO",
      "MODO",
      "INTENTOS",
      ...(portal ? ["EN MERCADO LIBRE", "VENCE"] : []),
      "ENLACE O ERROR",
    ],
    publications.map((publication) => [
      publication.id,
      PLATFORM_TEXT[publication.platform],
      publicationFormatText(publication.platform, publication.format),
      paintPublicationStatus(publication, c),
      publicationModeText(publication.dryRun),
      String(publication.attempts),
      ...(portal ? [remoteText(publication), expiresText(publication)] : []),
      outcomeOf(publication, c),
    ]),
    c,
  );
  const reasons = publications.flatMap((publication) => {
    const reason = publication.remoteState?.reason;
    return reason === undefined ? [] : [c.yellow(`  ${publication.id}: ${reason.message}`)];
  });
  return [table, ...reasons].join("\n");
}

/** Una línea por publicación al terminar de publicar: estado, modo, enlace o error y, en Portal, su estado allá. */
export function renderPublicationResult(publication: PublicationView, c: Colors): string {
  const head = `${publicationName(publication)}: ${paintPublicationStatus(publication, c)} (${publicationModeText(publication.dryRun)})`;
  const outcome = outcomeOf(publication, c);
  const lines = [...(outcome === "" ? [] : [outcome]), ...renderRemoteState(publication, c)];
  return [head, ...lines.map((line) => `  ${line}`)].join("\n");
}

/**
 * La bitácora de una publicación: cambios de estado y un intento por línea, con lo que se envió (o
 * se habría enviado en simulación). El detalle de un intento se lee con `publishAttemptPayloadSchema`.
 */
export function renderPublicationEvents(
  events: readonly PublicationEventView[],
  c: Colors,
): string {
  if (events.length === 0) return c.dim("  (sin eventos)");
  return events
    .map((event) => {
      const when = `  ${c.dim(formatDateTime(event.createdAt))}  ${PUBLICATION_ACTOR_TEXT[event.actor].padEnd(7)}`;
      if (event.type === "status_changed") {
        const from = event.fromStatus === null ? "nace" : PUBLICATION_STATUS_TEXT[event.fromStatus];
        const to = event.toStatus === null ? "?" : PUBLICATION_STATUS_TEXT[event.toStatus];
        // Un cambio que vino de leer la plataforma (el sync de Portal) dice qué leyó.
        const { sync, remoteStatus } = event.payload;
        const read =
          sync === true && typeof remoteStatus === "string"
            ? ` · leído de Mercado Libre: ${remoteStatusText({ status: remoteStatus, subStatus: [] })}`
            : "";
        return `${when}  ${from} → ${to}${read}`;
      }
      // La API no expone el detalle de una lectura (su estado queda en la publicación).
      if (event.type === "sync") return `${when}  lectura de Mercado Libre`;
      if (event.type !== "publish_attempt") return `${when}  ${event.type}`;
      const attempt = publishAttemptPayloadSchema.safeParse(event.payload);
      if (!attempt.success) return `${when}  intento (detalle ilegible)`;
      const { mode, attempt: number, retry, result, error, sent, notes } = attempt.data;
      const lines = [
        `${when}  intento ${number}${retry > 0 ? ` (reintento ${retry})` : ""} en ${mode === "dry-run" ? "simulación" : "vivo"}: ${PUBLISH_ATTEMPT_RESULT_TEXT[result]}`,
      ];
      if (error !== undefined) lines.push(`      ${c.red(`${error.code}: ${error.message}`)}`);
      if (sent !== undefined) {
        lines.push(
          c.dim(
            `      enviado: ${sent.media.length} medios · caption de ${sent.caption.length} caracteres · ${sent.account.displayName}`,
          ),
        );
      }
      // Las advertencias del intento (Portal: lo que dijo `validate`, como "sin cupo", D14).
      for (const note of notes ?? []) lines.push(c.yellow(`      nota: ${note}`));
      return lines.join("\n");
    })
    .join("\n");
}
