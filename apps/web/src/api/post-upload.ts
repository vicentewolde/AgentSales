import {
  type PostUploadCompleteResponse,
  type PostUploadRequest,
  postUploadCompleteResponseSchema,
  postUploadResponseSchema,
  UPLOAD_SHA256_UP_TO_BYTES,
} from "@agentsales/api/contracts";
import { type ApiClient, ApiError, unwrap } from "./client.js";
import { type BlobHasher, type UploadDeps, UploadFailure } from "./upload.js";

// Los medios de un post (spec F9 §4.5, ADR-0025): el panel pide una URL prefirmada por archivo,
// sube cada uno directo a R2 con avance y reintento, y avisa (`complete`). Ningún archivo pasa por
// la API. El sha256 va hasta 100 MB; sobre eso, no (F9-T17: Web Crypto necesita el archivo entero en
// memoria): lo calcula el worker en streaming y deduplica.

/** Un archivo elegido, como lo pide la API: con su sha256 solo hasta 100 MB. */
export async function postUploadEntry(
  file: Blob & { name: string },
  hash: BlobHasher,
): Promise<PostUploadRequest["files"][number]> {
  if (file.size > UPLOAD_SHA256_UP_TO_BYTES) return { name: file.name, size: file.size };
  return { name: file.name, size: file.size, sha256: await hash(file) };
}

export type PostUploadProgress = {
  phase: "hashing" | "uploading" | "completing";
  sentBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
};

export type UploadPostMediaOptions = UploadDeps & {
  signal: AbortSignal;
  onProgress?: (progress: PostUploadProgress) => void;
  /** Intentos por archivo ante un fallo pasajero (por defecto 3). */
  attempts?: number;
  /** Archivos a la vez (por defecto 2: un video grande no compite con muchos). */
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
};

const isRetriable = (error: unknown) =>
  error instanceof UploadFailure &&
  (error.status === undefined || error.status >= 500 || error.status === 429);

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Sube los medios de un post: sha256 de los de hasta 100 MB, pide las URLs, sube los que falten (los
 * que ya son un medio del post vuelven como `existing`) con hasta `attempts` intentos si el fallo es
 * pasajero, y termina con `complete`. Devuelve lo que respondió `complete`: los medios del post y,
 * en `uploaded`, los archivos grandes que el worker está revisando. Si un archivo no se pudo subir,
 * `UPLOAD_FAILED` con su nombre: volver a llamar reintenta (los ya subidos no se repiten).
 */
export async function uploadPostMedia(
  client: ApiClient,
  postId: string,
  files: readonly File[],
  options: UploadPostMediaOptions,
): Promise<PostUploadCompleteResponse> {
  const { signal } = options;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const progress: PostUploadProgress = {
    phase: "hashing",
    sentBytes: 0,
    totalBytes: 0,
    doneFiles: 0,
    totalFiles: files.length,
  };
  const report = () => options.onProgress?.({ ...progress });
  report();

  const entries: PostUploadRequest["files"] = [];
  for (const file of files) {
    if (signal.aborted) throw new DOMException("Subida cancelada", "AbortError");
    entries.push(await postUploadEntry(file, options.hash));
  }
  const { uploads } = await unwrap(
    client.posts[":id"].uploads.$post(
      { param: { id: postId }, json: { files: entries } },
      { init: { signal } },
    ),
    postUploadResponseSchema,
  );
  // La respuesta viene en el orden pedido; dos nombres con el mismo contenido son una sola subida.
  const pending = new Map<string, { url: string; headers: Record<string, string>; file: File }>();
  uploads.forEach((target, index) => {
    const file = files[index];
    if (target.status === "upload" && file !== undefined && !pending.has(target.uploadId)) {
      pending.set(target.uploadId, { url: target.url, headers: target.headers, file });
    }
  });
  const queue = [...pending.values()];
  progress.phase = "uploading";
  progress.totalFiles = queue.length;
  progress.totalBytes = queue.reduce((total, item) => total + item.file.size, 0);
  report();

  const attempts = options.attempts ?? 3;
  const uploadOne = async ({ url, headers, file }: (typeof queue)[number]) => {
    for (let attempt = 1; ; attempt += 1) {
      let sent = 0;
      try {
        await options.transport({
          url,
          headers,
          body: file,
          signal,
          onProgress: (loaded) => {
            progress.sentBytes += loaded - sent;
            sent = loaded;
            report();
          },
        });
        progress.sentBytes += file.size - sent;
        progress.doneFiles += 1;
        report();
        return;
      } catch (error) {
        progress.sentBytes -= sent;
        report();
        if (isAbort(error)) throw error;
        if (attempt >= attempts || !isRetriable(error)) {
          const changed = error instanceof UploadFailure && error.s3Code === "BadDigest";
          throw new ApiError(
            changed
              ? `${file.name} cambió mientras se subía: elígelo de nuevo`
              : `No se pudo subir ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
            "UPLOAD_FAILED",
          );
        }
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  };
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < queue.length) {
      const item = queue[next];
      next += 1;
      if (item === undefined) return;
      await uploadOne(item).catch((error: unknown) => {
        failure ??= error;
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 2, queue.length) }, worker),
  );
  // Lo que sí llegó queda como medio aunque otro archivo fallara: `complete` igual.
  progress.phase = "completing";
  report();
  const done = await unwrap(
    client.posts[":id"].uploads.complete.$post({ param: { id: postId } }, { init: { signal } }),
    postUploadCompleteResponseSchema,
  );
  if (failure !== undefined) throw failure;
  // Solo cuentan las de este pedido: una subida vieja que nadie terminó la cierra la limpieza.
  const missing = done.missing.filter((uploadId) => pending.has(uploadId));
  if (missing.length > 0) {
    throw new ApiError(
      `${missing.length} archivo(s) no llegaron completos a R2: vuelve a intentarlo`,
      "UPLOAD_FAILED",
    );
  }
  return done;
}
