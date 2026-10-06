import type { PublicationEventView, PublicationView } from "@agentsales/api/contracts";
import {
  PLATFORM_TEXT,
  PUBLICATION_FORMAT_TEXT,
  PUBLICATION_STATUS_TEXT,
  PUBLISH_ATTEMPT_RESULT_TEXT,
  publicationModeText,
  publishAttemptPayloadSchema,
} from "@agentsales/core";
import type { Colors } from "../colors.js";
import { formatDateTime, renderTable } from "../output.js";

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

/** `carrusel de Instagram`. */
export const publicationName = (publication: Pick<PublicationView, "format" | "platform">) =>
  `${PUBLICATION_FORMAT_TEXT[publication.format]} de ${PLATFORM_TEXT[publication.platform]}`;

/** El enlace si salió; si falló, el motivo; si no, nada. */
const outcomeOf = (publication: PublicationView, c: Colors) => {
  if (publication.externalUrl !== null) return publication.externalUrl;
  if (publication.lastError !== null) {
    return c.red(`${publication.lastError.code}: ${publication.lastError.message}`);
  }
  return "";
};

/** Tabla de publicaciones (spec F3 §4.9): id, canal, formato, estado, modo, intentos y enlace o error. */
export function renderPublications(publications: readonly PublicationView[], c: Colors): string {
  return renderTable(
    ["ID", "CANAL", "FORMATO", "ESTADO", "MODO", "INTENTOS", "ENLACE O ERROR"],
    publications.map((publication) => [
      publication.id,
      PLATFORM_TEXT[publication.platform],
      PUBLICATION_FORMAT_TEXT[publication.format],
      paintPublicationStatus(publication, c),
      publicationModeText(publication.dryRun),
      String(publication.attempts),
      outcomeOf(publication, c),
    ]),
    c,
  );
}

/** Una línea por publicación al terminar de publicar: estado, modo y enlace o error. */
export function renderPublicationResult(publication: PublicationView, c: Colors): string {
  const head = `${publicationName(publication)}: ${paintPublicationStatus(publication, c)} (${publicationModeText(publication.dryRun)})`;
  const outcome = outcomeOf(publication, c);
  return outcome === "" ? head : `${head}\n  ${outcome}`;
}

const ACTOR_TEXT = { system: "sistema", operator: "panel", cli: "CLI" } as const;

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
      const when = `  ${c.dim(formatDateTime(event.createdAt))}  ${ACTOR_TEXT[event.actor].padEnd(7)}`;
      if (event.type === "status_changed") {
        const from = event.fromStatus === null ? "nace" : PUBLICATION_STATUS_TEXT[event.fromStatus];
        const to = event.toStatus === null ? "?" : PUBLICATION_STATUS_TEXT[event.toStatus];
        return `${when}  ${from} → ${to}`;
      }
      if (event.type !== "publish_attempt") return `${when}  ${event.type}`;
      const attempt = publishAttemptPayloadSchema.safeParse(event.payload);
      if (!attempt.success) return `${when}  intento (detalle ilegible)`;
      const { mode, attempt: number, retry, result, error, sent } = attempt.data;
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
      return lines.join("\n");
    })
    .join("\n");
}
