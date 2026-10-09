import type { PublicationEventView } from "@agentsales/api/contracts";
import {
  PUBLICATION_ACTOR_TEXT,
  PUBLICATION_STATUS_TEXT,
  PUBLISH_ATTEMPT_RESULT_TEXT,
  publishAttemptPayloadSchema,
  remoteStatusText,
} from "@agentsales/core";
import { usePublicationEvents } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";

const timeText = (date: Date) =>
  date.toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santiago",
  });

/** Una línea de la bitácora: un cambio de estado o un intento, con lo que se envió. */
function EventLine({ event }: { event: PublicationEventView }) {
  const who = PUBLICATION_ACTOR_TEXT[event.actor];
  if (event.type === "status_changed") {
    const from = event.fromStatus === null ? "nace" : PUBLICATION_STATUS_TEXT[event.fromStatus];
    const to = event.toStatus === null ? "?" : PUBLICATION_STATUS_TEXT[event.toStatus];
    // Un cambio que vino de leer Mercado Libre (el sync de Portal) dice qué leyó; la API solo expone
    // el `status` (sin `subStatus` ni el motivo), como en la CLI.
    const { sync, remoteStatus } = event.payload;
    const read =
      sync === true && typeof remoteStatus === "string"
        ? ` · leído de Mercado Libre: ${remoteStatusText({ status: remoteStatus, subStatus: [] })}`
        : "";
    return (
      <li>
        {timeText(event.createdAt)} · {who}: {from} → {to}
        {read}
      </li>
    );
  }
  if (event.type === "sync") {
    return (
      <li>
        {timeText(event.createdAt)} · {who}: lectura de Mercado Libre
      </li>
    );
  }
  const attempt =
    event.type === "publish_attempt" ? publishAttemptPayloadSchema.safeParse(event.payload) : null;
  if (attempt === null || !attempt.success) {
    return (
      <li>
        {timeText(event.createdAt)} · {who}:{" "}
        {event.type === "publish_attempt" ? "intento (detalle ilegible)" : "otro evento"}
      </li>
    );
  }
  const { mode, attempt: number, retry, result, error, sent } = attempt.data;
  return (
    <li>
      {timeText(event.createdAt)} · intento {number}
      {retry > 0 ? ` (reintento ${retry})` : ""} en {mode === "dry-run" ? "simulación" : "vivo"}:{" "}
      {PUBLISH_ATTEMPT_RESULT_TEXT[result]}
      {error && (
        <span className="block text-red-700">
          {error.code}: {error.message}
        </span>
      )}
      {sent && (
        <span className="block text-slate-500">
          Enviado: {sent.media.length} medios · caption de {sent.caption.length} caracteres ·{" "}
          {sent.account.displayName}
        </span>
      )}
    </li>
  );
}

/** La bitácora de una publicación (se pide al abrirla): quién hizo qué y lo que se envió. */
export function PublicationEvents({ publicationId }: { publicationId: string }) {
  const events = usePublicationEvents(publicationId, true);
  if (events.isPending) return <p className="mt-2 text-xs text-slate-500">Cargando la bitácora…</p>;
  if (events.error) {
    return (
      <ErrorAlert
        error={events.error}
        onRetry={() => void events.refetch()}
        retrying={events.isFetching}
      />
    );
  }
  return (
    <ol aria-label="Bitácora" className="mt-2 space-y-1 text-xs text-slate-700">
      {events.data.map((event) => (
        <EventLine key={event.id} event={event} />
      ))}
    </ol>
  );
}
