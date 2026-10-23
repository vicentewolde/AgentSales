import type { PostJson, PostMediaItem } from "@agentsales/api/contracts";
import { POST_MEDIA_TYPES, POST_UPLOAD } from "@agentsales/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useApiClient, useUploadDeps } from "../../api/context.js";
import { type PostUploadProgress, uploadPostMedia } from "../../api/post-upload.js";
import { mediaProcessing, postKeys } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { FILE_INPUT } from "../ui/styles.js";
import { GetImagePanel } from "./GetImagePanel.js";
import { POST_MEDIA_ANCHOR } from "./media-anchor.js";

/** Lo que acepta el selector: las extensiones de core (la API vuelve a revisar). */
const ACCEPT = Object.keys(POST_MEDIA_TYPES)
  .map((extension) => `.${extension}`)
  .join(",");

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

function progressText(progress: PostUploadProgress): string {
  if (progress.phase === "hashing") return "Preparando los archivos…";
  if (progress.phase === "completing") return "Registrando los medios…";
  const percent =
    progress.totalBytes === 0 ? 100 : Math.round((progress.sentBytes / progress.totalBytes) * 100);
  return `Subiendo ${progress.doneFiles} de ${progress.totalFiles} · ${percent} % (${mb(progress.sentBytes)} de ${mb(progress.totalBytes)})`;
}

/**
 * Los medios del post (spec F9 §4.5): los que tiene, con "procesando…" mientras el worker arma sus
 * variantes, y subir más directo a R2 con avance, cancelar y reintentar. Un archivo de más de
 * 100 MB va sin sha256 (F9-T17): el worker lo revisa y aparece al rato (`waiting`, lo que la API
 * cuenta como `uploadsInReview`).
 */
export function PostMedia({
  postId,
  media,
  lockReason,
  waiting,
  kind,
}: {
  postId: string;
  /** El tipo del post: «Conseguir imagen» (F9.5-T25) no aparece en uno de solo texto. */
  kind?: PostJson["kind"];
  media: readonly PostMediaItem[];
  /** Por qué no se pueden subir medios (el post está archivado). */
  lockReason: string | null;
  /** Archivos grandes que el worker todavía revisa (todavía no son medios). */
  waiting: number;
}) {
  const id = useId();
  const client = useApiClient();
  const deps = useUploadDeps();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<PostUploadProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [failed, setFailed] = useState<File[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Al salir de la página se corta lo que se estaba subiendo.
  useEffect(() => () => abort.current?.abort(), []);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length > POST_UPLOAD.maxFilesPerRequest) {
      setError(new Error(`Se suben hasta ${POST_UPLOAD.maxFilesPerRequest} archivos por vez`));
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setFailed(null);
    try {
      await uploadPostMedia(client, postId, files, {
        ...deps,
        signal: controller.signal,
        onProgress: setProgress,
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setError(new Error("Subida cancelada: lo que alcanzó a subir quedó guardado."));
      } else {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setFailed(files);
      }
    } finally {
      abort.current = null;
      setProgress(null);
      if (input.current !== null) input.current.value = "";
      void queryClient.invalidateQueries({ queryKey: postKeys.detail(postId) });
    }
  };

  const uploading = progress !== null;
  return (
    <Card
      as="section"
      id={POST_MEDIA_ANCHOR}
      aria-label="Medios"
      title={`Fotos y videos (${media.length})`}
    >
      {media.length === 0 ? (
        <p className="text-sm text-fg-muted">Sin medios: un post de solo texto no los necesita.</p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {media.map((item, index) => (
            <li key={item.id} className="w-28 text-xs text-fg-muted tabular-nums">
              {item.thumbUrl !== null ? (
                <img
                  src={item.thumbUrl}
                  alt={`${item.kind === "video" ? "Video" : "Foto"} ${index + 1}`}
                  className="h-28 w-28 rounded-lg border border-line object-cover"
                />
              ) : (
                <span
                  role="img"
                  aria-label={`${item.kind === "video" ? "Video" : "Foto"} ${index + 1}`}
                  className="flex h-28 w-28 items-center justify-center rounded-lg border border-line bg-slate-100"
                >
                  {item.kind === "video" ? "video" : "foto"}
                </span>
              )}
              <span className="mt-1 block">
                {item.kind === "video" && item.durationS !== null
                  ? `${Math.round(item.durationS)} s · `
                  : ""}
                {mb(item.bytes)}
              </span>
              {mediaProcessing(item) && <span className="block text-warning-800">procesando…</span>}
            </li>
          ))}
        </ul>
      )}
      {waiting > 0 && (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          {waiting === 1
            ? "Un archivo grande se está revisando en el servidor: aparece aquí en unos minutos."
            : `${waiting} archivos grandes se están revisando en el servidor: aparecen aquí en unos minutos.`}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          Subir fotos o videos
        </label>
        <input
          id={id}
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          disabled={uploading || lockReason !== null}
          onChange={(event) => void upload([...(event.target.files ?? [])])}
          className={FILE_INPUT}
        />
        {lockReason !== null && <span className="text-xs text-warning-800">{lockReason}</span>}
      </div>
      <p className="mt-1.5 text-xs text-fg-subtle">
        JPG, PNG, WebP, HEIC, MP4 o MOV; hasta {POST_UPLOAD.maxMediaPerPost} por post.
      </p>
      {progress !== null && (
        <div className="mt-3 space-y-2 text-sm" role="status">
          <progress
            aria-label="Avance de la subida"
            max={Math.max(progress.totalBytes, 1)}
            value={progress.sentBytes}
            className="w-64 max-w-full"
          />
          <p className="text-fg-muted tabular-nums">{progressText(progress)}</p>
          <Button variant="secondary" size="sm" onClick={() => abort.current?.abort()}>
            Cancelar
          </Button>
        </div>
      )}
      {error !== null && (
        <ErrorAlert
          error={error}
          {...(failed === null ? {} : { onRetry: () => void upload(failed) })}
        />
      )}
      {kind !== undefined && <GetImagePanel post={{ id: postId, kind }} lockReason={lockReason} />}
    </Card>
  );
}
