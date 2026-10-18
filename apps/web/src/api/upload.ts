import {
  type ImportRunView,
  type ImportUploadRequest,
  type ImportUploadTargetView,
  importRunResponseSchema,
  importUploadResponseSchema,
  MAX_FOLDER_FILES,
  UPLOAD_SHA256_UP_TO_BYTES,
} from "@agentsales/api/contracts";
import { type ApiClient, ApiError, unwrap } from "./client.js";

// El panel sube la planilla y los medios directo a R2 con las URLs prefirmadas de la API (spec F8
// §4.4, ADR-0025): pide la carga, sube cada archivo con avance y reintento, y la empieza. Ningún
// archivo pasa por la API.

/** Un `PUT` a R2 con su avance; lanza `UploadFailure` (o `AbortError` al cancelar). */
export type UploadTransport = (request: {
  url: string;
  headers: Record<string, string>;
  body: Blob;
  signal: AbortSignal;
  /** Bytes enviados hasta ahora de este archivo. */
  onProgress(loaded: number): void;
}) => Promise<void>;

/** sha256 hexadecimal de un archivo (Web Crypto; los tests pasan uno de Node). */
export type BlobHasher = (blob: Blob) => Promise<string>;

/** Lo que el panel inyecta para subir (los tests, un R2 en memoria). */
export type UploadDeps = { transport: UploadTransport; hash: BlobHasher };

/** Un `PUT` que R2 rechazó (`status`) o que no llegó (sin `status`). */
export class UploadFailure extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly s3Code?: string,
  ) {
    super(message);
    this.name = "UploadFailure";
  }
}

const abortError = () => new DOMException("Subida cancelada", "AbortError");

/** El `PUT` del navegador: `XMLHttpRequest`, porque `fetch` no informa el avance de una subida. */
export const xhrTransport: UploadTransport = ({ url, headers, body, signal, onProgress }) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      const code = /<Code>([^<]+)<\/Code>/.exec(request.responseText ?? "")?.[1];
      reject(new UploadFailure(`R2 respondió ${request.status}`, request.status, code));
    };
    // Sin respuesta (red caída o la regla de CORS del bucket no lo deja): sin `status`.
    request.onerror = () => reject(new UploadFailure("No se pudo llegar a R2"));
    request.onabort = () => reject(abortError());
    const onAbort = () => request.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    request.onloadend = () => signal.removeEventListener("abort", onAbort);
    request.send(body);
  });

export const webCryptoHash: BlobHasher = async (blob) => {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const browserUploadDeps: UploadDeps = { transport: xhrTransport, hash: webCryptoHash };

/** Una carpeta elegida en el navegador: sus archivos con la ruta relativa a ella. */
export type FolderSelection = {
  kind: "folder";
  name: string;
  files: { path: string; file: File }[];
};

export type ImportSelection = {
  file: File;
  media: { kind: "zip"; file: File } | FolderSelection | null;
  broker?: string;
  dryRun: boolean;
};

/** Lo que no se sube de una carpeta: ocultos y basura de macOS, como al leer un zip. */
const isIgnoredPath = (path: string) =>
  path.split("/").some((segment) => segment.startsWith(".") || segment === "__MACOSX");

/**
 * Los archivos de un `<input webkitdirectory>`: `webkitRelativePath` trae primero la carpeta
 * elegida ("medios/P001/foto.jpg"); se guarda su nombre y las rutas quedan relativas a ella.
 */
export function folderSelection(files: readonly File[]): FolderSelection | null {
  const entries = files
    .map((file) => ({ file, full: (file.webkitRelativePath || file.name).replaceAll("\\", "/") }))
    .filter(({ full }) => !isIgnoredPath(full));
  if (entries.length === 0) return null;
  const name = entries[0]?.full.split("/")[0] ?? "medios";
  return {
    kind: "folder",
    name,
    files: entries.map(({ file, full }) => ({
      file,
      path: full.startsWith(`${name}/`) ? full.slice(name.length + 1) : full,
    })),
  };
}

/** Lo que el panel revisa antes de pedir la subida de una carpeta. */
export function checkFolder(folder: FolderSelection): string | null {
  if (folder.files.length > MAX_FOLDER_FILES) {
    return `La carpeta tiene más de ${MAX_FOLDER_FILES} archivos: sepárala en varias cargas o súbela como .zip.`;
  }
  return null;
}

export type UploadProgress = {
  phase: "hashing" | "uploading" | "starting";
  sentBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
};

export type UploadImportOptions = UploadDeps & {
  signal: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  /** Intentos por archivo (por defecto 3). */
  attempts?: number;
  /** Archivos a la vez (por defecto 3). */
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
};

const isRetriable = (error: unknown) =>
  error instanceof UploadFailure &&
  (error.status === undefined || error.status >= 500 || error.status === 429);

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Sube una carga (spec F8 §4.4): calcula el sha256 de la planilla y de los archivos de carpeta de
 * hasta 100 MB (el zip va solo con su tamaño), pide las URLs, sube cada archivo con avance y hasta
 * `attempts` intentos si el fallo es pasajero, y empieza la carga. Devuelve la carga en cola.
 *
 * Cancelar (`signal`) corta las subidas en curso y no empieza la carga: queda esperando sus
 * archivos y se cierra sola a las 24 h.
 */
export async function uploadImport(
  client: ApiClient,
  selection: ImportSelection,
  options: UploadImportOptions,
): Promise<ImportRunView> {
  const { signal } = options;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const progress: UploadProgress = {
    phase: "hashing",
    sentBytes: 0,
    totalBytes: 0,
    doneFiles: 0,
    totalFiles: 0,
  };
  const report = () => options.onProgress?.({ ...progress });
  report();

  // El archivo de cada URL, por su tipo y su nombre: una carpeta puede traer un archivo que se
  // llama como la planilla.
  const keyOf = (target: Pick<ImportUploadTargetView, "kind" | "name">) =>
    `${target.kind}:${target.name}`;
  const local = new Map<string, Blob>([
    [keyOf({ kind: "xlsx", name: selection.file.name }), selection.file],
  ]);
  const request: ImportUploadRequest = {
    ...(selection.broker ? { broker: selection.broker } : {}),
    dryRun: selection.dryRun,
    xlsx: {
      name: selection.file.name,
      size: selection.file.size,
      sha256: await options.hash(selection.file),
    },
    media: null,
  };
  const { media } = selection;
  if (media?.kind === "zip") {
    local.set(keyOf({ kind: "zip", name: media.file.name }), media.file);
    request.media = { kind: "zip", name: media.file.name, size: media.file.size };
  } else if (media?.kind === "folder") {
    const files: { path: string; size: number; sha256?: string }[] = [];
    for (const { path, file } of media.files) {
      if (signal.aborted) throw abortError();
      local.set(keyOf({ kind: "file", name: path }), file);
      files.push({
        path,
        size: file.size,
        ...(file.size <= UPLOAD_SHA256_UP_TO_BYTES ? { sha256: await options.hash(file) } : {}),
      });
    }
    request.media = { kind: "folder", name: media.name, files };
  }
  if (signal.aborted) throw abortError();

  const { importRun, uploads } = await unwrap(
    client.imports.uploads.$post({ json: request }, { init: { signal } }),
    importUploadResponseSchema,
  );
  progress.phase = "uploading";
  progress.totalFiles = uploads.length;
  progress.totalBytes = uploads.reduce(
    (total, target) => total + (local.get(keyOf(target))?.size ?? 0),
    0,
  );
  report();

  const attempts = options.attempts ?? 3;
  async function uploadOne(target: ImportUploadTargetView): Promise<void> {
    const body = local.get(keyOf(target));
    if (body === undefined)
      throw new ApiError(`La API pidió un archivo que no está: ${target.name}`);
    for (let attempt = 1; ; attempt += 1) {
      let sent = 0;
      try {
        await options.transport({
          url: target.url,
          headers: target.headers,
          body,
          signal,
          onProgress: (loaded) => {
            progress.sentBytes += loaded - sent;
            sent = loaded;
            report();
          },
        });
        progress.sentBytes += body.size - sent;
        progress.doneFiles += 1;
        report();
        return;
      } catch (error) {
        progress.sentBytes -= sent;
        if (isAbort(error)) throw error;
        if (attempt >= attempts || !isRetriable(error)) {
          const changed = error instanceof UploadFailure && error.s3Code === "BadDigest";
          const forbidden = error instanceof UploadFailure && error.status === 403;
          throw new ApiError(
            changed
              ? `${target.name} cambió mientras se subía: elígelo de nuevo`
              : forbidden
                ? `No se pudo subir ${target.name}: la URL de subida venció o no calza (dura 6 h); vuelve a importar`
                : `No se pudo subir ${target.name}: ${error instanceof Error ? error.message : String(error)}`,
            "UPLOAD_FAILED",
          );
        }
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < uploads.length) {
      const target = uploads[next];
      next += 1;
      if (target === undefined) return;
      await uploadOne(target).catch((error: unknown) => {
        failure ??= error;
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 3, uploads.length) }, worker),
  );
  if (failure !== undefined) throw failure;

  progress.phase = "starting";
  report();
  return (
    await unwrap(
      client.imports[":id"].start.$post({ param: { id: importRun.id } }, { init: { signal } }),
      importRunResponseSchema,
    )
  ).importRun;
}
