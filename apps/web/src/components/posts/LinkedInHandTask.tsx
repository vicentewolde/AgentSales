import { Link } from "react-router";
import { usePost, usePostPublicationAction } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { LinkedInOpenControl } from "./LinkedInAssist.js";
import { linkedinDownloads } from "./linkedin.js";

/**
 * «LinkedIn: publica a mano» en «Hoy» y en la agenda de Seguimiento (F9.5): el mismo botón de un
 * clic del post, sin entrar a él. 1) «Copiar texto y abrir LinkedIn», 2) «Publicar» en LinkedIn,
 * 3) «Ya lo publiqué» (sin enlace; el enlace es opcional y se puede poner desde el post). Lee el
 * post de la tarea para traer el texto aprobado y los medios; si no lo encuentra, manda al post.
 */
export function LinkedInHandTask({
  postId,
  publicationId,
}: {
  postId: string;
  publicationId: string;
}) {
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
    return <p className="mt-2 text-sm text-fg-muted">Cargando el texto de LinkedIn…</p>;
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
        y publícalo a mano en LinkedIn.
      </p>
    );
  }
  return (
    <section aria-label="LinkedIn: publica a mano" className="mt-2 min-w-0">
      <LinkedInOpenControl
        content={content}
        downloads={linkedinDownloads(detail.media, detail.post.kind)}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={action.isPending}
          onClick={() => action.mutate({ kind: "confirm", id: publicationId, withoutUrl: true })}
        >
          Ya lo publiqué
        </Button>
        <Link
          to={postPath}
          className="text-xs font-medium text-brand-800 underline underline-offset-2"
        >
          Poner el enlace o no la publiqué
        </Link>
      </div>
      <p className="mt-1 text-xs text-fg-subtle">
        Sin el enlace no podrás abrir el post desde Seguimiento.
      </p>
      {action.error && <ErrorAlert error={action.error} />}
    </section>
  );
}
