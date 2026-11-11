import type { PublishMode } from "@agentsales/core";
import { useId, useState } from "react";
import { Link } from "react-router";
import { usePost, usePostPublicationAction } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { PublicationMode } from "../publications/PublicationMode.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";
import { HandOpenControl } from "./HandAssist.js";
import { HAND_LABEL, type HandPlatform } from "./hand.js";
import { linkedinDownloads } from "./linkedin.js";

/**
 * «<Red>: publica a mano» en «Hoy» y en la agenda de Seguimiento (F9.5 para LinkedIn, F9.6 para X e
 * Instagram): el mismo botón de un clic del post, sin entrar a él. 1) «Copiar texto…», 2) publicar
 * en la red, 3) «Ya lo publiqué». El enlace es opcional y se puede pegar aquí mismo antes de
 * confirmar (o, si ya confirmaste sin él, agregarlo después desde el post). Lee el post de la tarea para traer el texto aprobado y los
 * medios de la publicación; si no lo encuentra, manda al post. Dice el modo (simulación o en vivo).
 */
export function HandTask({
  platform,
  postId,
  publicationId,
  mode,
  publishMode,
}: {
  platform: HandPlatform;
  postId: string;
  publicationId: string;
  /** El modo de la publicación en la agenda (`dryRun` y si ya está fijado). */
  mode: { dryRun: boolean | null; modeFixed: boolean };
  /** El modo de la marca, mientras el de la publicación no está fijado. */
  publishMode?: PublishMode | undefined;
}) {
  const label = HAND_LABEL[platform];
  const linkId = useId();
  const [url, setUrl] = useState("");
  const link = url.trim() === "" ? undefined : url.trim();
  const post = usePost(postId);
  const action = usePostPublicationAction(postId);
  const detail = post.data;
  const postPath = `/contenido/${postId}`;
  if (post.error !== null) {
    return (
      <div className="mt-2">
        <ErrorAlert
          error={post.error}
          onRetry={() => void post.refetch()}
          retrying={post.isFetching}
        />
      </div>
    );
  }
  if (detail === undefined) {
    return <p className="mt-2 text-sm text-fg-muted">Cargando el texto de {label}…</p>;
  }
  const publication = detail.publications.find((item) => item.id === publicationId);
  // Ya confirmada (u otro estado) mientras la agenda no se releía: nada que hacer aquí.
  if (publication === undefined || publication.status !== "awaiting_manual_confirm") return null;
  const content = detail.contents.find((item) => item.id === publication.contentId);
  if (content === undefined) {
    return (
      <p role="status" className="mt-2 text-sm text-warning-800">
        No encontré el texto aprobado: ábrelo en{" "}
        <Link to={postPath} className="font-semibold underline underline-offset-2">
          el post
        </Link>{" "}
        y publícalo a mano en {label}.
      </p>
    );
  }
  return (
    <section aria-label={`${label}: publica a mano`} className="mt-2 min-w-0">
      {mode.dryRun !== null && (
        <p className="mb-1.5 text-xs">
          <PublicationMode
            publication={{ dryRun: mode.dryRun, modeFixed: mode.modeFixed }}
            publishMode={publishMode}
          />
        </p>
      )}
      <HandOpenControl
        platform={platform}
        content={content}
        downloads={linkedinDownloads(publication.media)}
      />
      <div className="mt-3 min-w-0">
        <label htmlFor={linkId} className="mb-1 block text-xs font-medium text-fg">
          Enlace de la publicación (opcional)
        </label>
        <Input
          id={linkId}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
          autoComplete="off"
          aria-describedby={`${linkId}-help`}
        />
        <p id={`${linkId}-help`} className="mt-1 text-xs text-fg-subtle">
          Pégalo si ya lo tienes: con él podrás abrir el post desde Seguimiento. Si no, confirma sin
          él y agrégalo después en el post.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={action.isPending}
          onClick={() =>
            action.mutate(
              link === undefined
                ? { kind: "confirm", id: publicationId, withoutUrl: true }
                : { kind: "confirm", id: publicationId, url: link },
            )
          }
        >
          Ya lo publiqué
        </Button>
        <Link
          to={postPath}
          className="text-xs font-medium text-brand-800 underline underline-offset-2"
        >
          Abrir el post (o si no la publiqué)
        </Link>
      </div>
      {action.error && <ErrorAlert error={action.error} />}
    </section>
  );
}
