import type { PublicationView } from "@agentsales/api/contracts";
import { PLATFORM_TEXT } from "@agentsales/core";
import { useId, useState } from "react";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";

/**
 * Lo que pide el bloque: decir si salió una con resultado dudoso (`resolve`) o confirmar (con su
 * enlace) o no una que se publica a mano. Las acciones de avisos y de posts lo incluyen.
 */
export type OutcomeAction =
  | { kind: "resolve"; id: string; outcome: "published" | "not_published"; url?: string }
  | { kind: "confirm"; id: string; url?: string }
  | { kind: "not-published"; id: string };

/**
 * Decir si salió una publicación con resultado dudoso (`outcome_unknown`, ADR-0029 punto 8) o
 * confirmar una que se publica a mano (`awaiting_manual_confirm`: LinkedIn, TikTok), con su enlace.
 * Lo usan los posts (F9-T17) y, desde F9.5-T04b, los avisos de una propiedad (Instagram y Portal).
 * El enlace no se guarda en la caché ni se muestra de vuelta: va solo en el pedido.
 *
 * En Portal con el sistema en vivo, «salió» necesita el enlace del aviso o su número (`MLC…`): sin
 * él la API responde `PUBLISHED_URL_REQUIRED`, así que el botón espera a que se pegue. «No salió»
 * en Portal pide confirmar antes (`confirmNotPublished`): si en Mercado Libre quedaron avisos (uno
 * o varios, el caso «many»), se cierran a mano primero, porque volver a publicar gasta otro cupo.
 * `error` (los avisos) se muestra en el mismo bloque, con el mensaje de la API.
 */
export function OutcomeBox({
  publication,
  pending,
  onAction,
  detail,
  confirmNotPublished,
  error,
}: {
  publication: Pick<PublicationView, "id" | "status" | "platform" | "dryRun">;
  pending: boolean;
  onAction: (action: OutcomeAction) => void;
  /** Lo que dijo la red al cortarse (el mensaje de `lastError`), debajo de la explicación. */
  detail?: string | null;
  /** Si «No salió» se confirma antes, el texto de la confirmación. */
  confirmNotPublished?: string | null;
  /** El error del último pedido de este bloque. */
  error?: Error | null;
}) {
  const id = useId();
  const helpId = useId();
  const [url, setUrl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const link = url.trim() === "" ? undefined : url.trim();
  const unknown = publication.status === "outcome_unknown";
  const network = PLATFORM_TEXT[publication.platform];
  const portal = publication.platform === "portal_inmobiliario";
  const linkRequired = unknown && portal && !publication.dryRun;
  const notPublished = (): OutcomeAction =>
    unknown
      ? { kind: "resolve", id: publication.id, outcome: "not_published" }
      : { kind: "not-published", id: publication.id };
  return (
    <fieldset
      aria-label={unknown ? "Decir si salió" : "Confirmar la publicación a mano"}
      className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
    >
      <p className="text-warning-800">
        {unknown
          ? `No se sabe si salió: se cortó justo al enviar. Revisa ${portal ? "tus publicaciones en Mercado Libre" : network} y di si está publicada (no se reintenta sola, para no publicarla dos veces).`
          : `Publícala a mano en ${network} con el texto aprobado y los medios del post, y después confírmala aquí con su enlace.`}
      </p>
      {detail !== undefined && detail !== null && detail !== "" && (
        <p className="mt-1 text-fg-muted">{detail}</p>
      )}
      <label htmlFor={id} className="mt-3 mb-1.5 block font-medium text-fg">
        {portal ? "Enlace del aviso o su número (MLC…)" : "Enlace de la publicación"}
        {publication.dryRun ? " (en simulación no hace falta)" : ""}
      </label>
      <Input
        id={id}
        type={portal ? "text" : "url"}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder={portal ? "https://… o MLC…" : "https://"}
        autoComplete="off"
        {...(linkRequired ? { "aria-describedby": helpId, required: true } : {})}
      />
      {linkRequired && (
        <p id={helpId} className="mt-1 text-fg-muted">
          Con el sistema en vivo es obligatorio: cópialo de la barra del navegador con el aviso
          abierto en Portal Inmobiliario o Mercado Libre, o escribe su número de publicación
          (empieza con MLC).
        </p>
      )}
      {confirming ? (
        <div role="alert" className="mt-3 rounded-md border border-danger-200 bg-danger-50 p-2">
          <p className="font-semibold text-danger-800">{confirmNotPublished}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => onAction(notPublished())}
            >
              Sí, no quedó ninguno
            </Button>
            <Button
              variant="link"
              autoFocus
              className="text-xs"
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending || (linkRequired && link === undefined)}
            onClick={() =>
              onAction(
                unknown
                  ? {
                      kind: "resolve",
                      id: publication.id,
                      outcome: "published",
                      ...(link === undefined ? {} : { url: link }),
                    }
                  : {
                      kind: "confirm",
                      id: publication.id,
                      ...(link === undefined ? {} : { url: link }),
                    },
              )
            }
          >
            {unknown ? "Sí, salió" : "Lo publiqué"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              confirmNotPublished !== undefined && confirmNotPublished !== null
                ? setConfirming(true)
                : onAction(notPublished())
            }
          >
            {unknown ? "No salió" : "No lo publiqué"}
          </Button>
        </div>
      )}
      {error !== undefined && error !== null && <ErrorAlert error={error} />}
    </fieldset>
  );
}
