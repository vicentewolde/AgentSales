import { isPostPlatform } from "@agentsales/core";
import { useId, useState } from "react";
import { usePostPublicationAction, useRecordPost } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";
import type { AgendaItem } from "./agenda.js";

// «¿Salió?» (spec F9.7 B10): una publicación a mano cuya hora pasó hace más de 12 h. «Ya lo
// publiqué» (con el enlace o, si está lista para publicar a mano, también sin él) y «No salió».
// Lista para publicar a mano: confirmar o decir que no salió. Aprobada o programada: registrar con
// su enlace que ya salió (`post record`) o cancelarla para volver a programarla.

export function DidItGoOut({ item }: { item: AgendaItem }) {
  const postId = item.postId ?? "";
  const publicationId = item.publicationId ?? "";
  const action = usePostPublicationAction(postId);
  const record = useRecordPost(postId);
  const [url, setUrl] = useState("");
  const inputId = useId();
  if (item.postId === null || item.publicationId === null || item.platform === null) return null;
  const link = url.trim();
  const waiting = item.action === "confirm";
  const platform = item.platform;
  const error = action.error ?? record.error;
  const done = action.isSuccess || record.isSuccess;
  if (done) {
    return (
      <p role="status" className="mt-2 text-sm text-success-800">
        Listo: quedó anotado.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-fg">
        Enlace del post publicado {waiting ? "(opcional en LinkedIn)" : ""}
      </label>
      <Input
        id={inputId}
        type="url"
        inputMode="url"
        placeholder="https://"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      {error && <ErrorAlert error={error} />}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={action.isPending || record.isPending}
          disabled={!waiting && link === ""}
          onClick={() => {
            if (waiting) {
              action.mutate(
                link === ""
                  ? { kind: "confirm", id: publicationId, withoutUrl: true }
                  : { kind: "confirm", id: publicationId, url: link },
              );
            } else if (isPostPlatform(platform)) {
              record.mutate({ platform, language: item.language ?? "es", url: link });
            }
          }}
        >
          Ya lo publiqué
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={action.isPending}
          onClick={() =>
            action.mutate(
              waiting
                ? { kind: "not-published", id: publicationId }
                : { kind: "cancel", id: publicationId },
            )
          }
        >
          No salió
        </Button>
      </div>
    </div>
  );
}
