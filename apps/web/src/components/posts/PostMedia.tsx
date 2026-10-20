import type { PostMediaItem } from "@agentsales/api/contracts";
import { POST_MEDIA_TYPES, POST_UPLOAD } from "@agentsales/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useApiClient, useUploadDeps } from "../../api/context.js";
import { type PostUploadProgress, uploadPostMedia } from "../../api/post-upload.js";
import { mediaProcessing, postKeys } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";

const SECONDARY =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";

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
 * 100 MB va sin sha256 (F9-T17): el worker lo revisa y aparece al rato (`onBigUploaded`).
 */
export function PostMedia({
  postId,
  media,
  lockReason,
  waiting,
  onBigUploaded,
}: {
  postId: string;
  media: readonly PostMediaItem[];
  /** Por qué no se pueden subir medios (el post está archivado). */
  lockReason: string | null;
  /** Archivos grandes que el worker todavía revisa (todavía no son medios). */
  waiting: number;
  /** Cuántos archivos grandes quedaron en revisión en el worker. */
  onBigUploaded: (count: number) => void;
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
      const done = await uploadPostMedia(client, postId, files, {
        ...deps,
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (done.uploaded.length > 0) onBigUploaded(done.uploaded.length);
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
    <section aria-label="Medios" className="mt-6">
      <h2 className="text-lg font-semibold">Fotos y videos ({media.length})</h2>
      {media.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">
          Sin medios: un post de solo texto no los necesita.
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-3">
          {media.map((item, index) => (
            <li key={item.id} className="w-28 text-xs text-slate-600">
              {item.thumbUrl !== null ? (
                <img
                  src={item.thumbUrl}
                  alt={`${item.kind === "video" ? "Video" : "Foto"} ${index + 1}`}
                  className="h-28 w-28 rounded border border-slate-200 object-cover"
                />
              ) : (
                <span
                  role="img"
                  aria-label={`${item.kind === "video" ? "Video" : "Foto"} ${index + 1}`}
                  className="flex h-28 w-28 items-center justify-center rounded border border-slate-200 bg-slate-100"
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
              {mediaProcessing(item) && <span className="block text-amber-800">procesando…</span>}
            </li>
          ))}
        </ul>
      )}
      {waiting > 0 && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {waiting === 1
            ? "Un archivo grande se está revisando en el servidor: aparece aquí en unos minutos."
            : `${waiting} archivos grandes se están revisando en el servidor: aparecen aquí en unos minutos.`}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
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
          className="text-sm"
        />
        {lockReason !== null && <span className="text-xs text-amber-800">{lockReason}</span>}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        JPG, PNG, WebP, HEIC, MP4 o MOV; hasta {POST_UPLOAD.maxMediaPerPost} por post.
      </p>
      {progress !== null && (
        <div className="mt-2 text-sm" role="status">
          <progress
            aria-label="Avance de la subida"
            max={Math.max(progress.totalBytes, 1)}
            value={progress.sentBytes}
            className="w-64"
          />
          <p className="text-slate-700">{progressText(progress)}</p>
          <button type="button" className={SECONDARY} onClick={() => abort.current?.abort()}>
            Cancelar
          </button>
        </div>
      )}
      {error !== null && (
        <ErrorAlert
          error={error}
          {...(failed === null ? {} : { onRetry: () => void upload(failed) })}
        />
      )}
    </section>
  );
}
