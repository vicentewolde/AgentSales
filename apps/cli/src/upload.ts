import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { join, posix, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ImportUploadRequest, ImportUploadTargetView } from "@agentsales/api/contracts";
import { MAX_FOLDER_FILES } from "@agentsales/api/contracts";
import { CliError } from "./output.js";

// La CLI sube la planilla y los medios directo a R2 con las URLs prefirmadas de la API (spec F8
// §4.4 y §4.5, ADR-0025): en streaming (un zip de 4 GB no pasa por la memoria) y con reintento por
// archivo. Nunca imprime las URLs (la firma da acceso de escritura).

/** Un archivo a subir: su ruta en el Mac y lo que se anuncia a la API. */
export type LocalUpload = { path: string; size: number; sha256?: string };

export type ImportManifest = {
  request: Pick<ImportUploadRequest, "xlsx" | "media">;
  /**
   * El archivo local de cada URL, por `uploadKey` (su tipo y su nombre: una carpeta puede traer un
   * archivo que se llama como la planilla).
   */
  files: Map<string, LocalUpload>;
};

/** La clave de un archivo de la carga: su tipo (`xlsx`, `zip`, `file`) y su nombre o ruta. */
export const uploadKey = (target: Pick<ImportUploadTargetView, "kind" | "name">) =>
  `${target.kind}:${target.name}`;

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Lo que no se sube de una carpeta: ocultos y basura de macOS, como al leer un zip. */
const isIgnored = (name: string) => name.startsWith(".") || name === "__MACOSX";

/**
 * Los archivos de una carpeta de medios, con su ruta relativa (con `/`), recorridos en orden. Se
 * saltan los ocultos, `__MACOSX` y lo que no es un archivo (enlaces, dispositivos).
 */
export async function scanMediaFolder(
  dir: string,
): Promise<{ path: string; size: number; rel: string }[]> {
  const found: { path: string; size: number; rel: string }[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        found.push({
          path,
          size: (await stat(path)).size,
          rel: relative(dir, path).split(sep).join(posix.sep),
        });
        if (found.length > MAX_FOLDER_FILES) {
          throw new CliError(
            "IMPORT_UPLOAD_INVALID",
            `La carpeta de medios tiene más de ${MAX_FOLDER_FILES} archivos`,
            "Sepárala en varias cargas, o comprímela en un .zip",
          );
        }
      }
    }
  }
  await walk(dir);
  return found;
}

/**
 * Arma el pedido de `POST /imports/uploads`: la planilla con su sha256 y, si hay, el zip (solo su
 * tamaño) o los archivos de la carpeta (cada uno con su sha256: la CLI lo calcula en streaming,
 * también para los grandes).
 */
export async function buildImportManifest(
  xlsxPath: string,
  media: { kind: "zip" | "dir"; path: string } | undefined,
): Promise<ImportManifest> {
  const files = new Map<string, LocalUpload>();
  const xlsxName = posix.basename(xlsxPath.split(sep).join(posix.sep));
  const xlsx = {
    path: xlsxPath,
    size: (await stat(xlsxPath)).size,
    sha256: await sha256Of(xlsxPath),
  };
  files.set(uploadKey({ kind: "xlsx", name: xlsxName }), xlsx);
  const request: ImportManifest["request"] = {
    xlsx: { name: xlsxName, size: xlsx.size, sha256: xlsx.sha256 },
    media: null,
  };
  if (media?.kind === "zip") {
    const name = posix.basename(media.path.split(sep).join(posix.sep));
    const size = (await stat(media.path)).size;
    files.set(uploadKey({ kind: "zip", name }), { path: media.path, size });
    request.media = { kind: "zip", name, size };
  } else if (media?.kind === "dir") {
    const scanned = await scanMediaFolder(media.path);
    if (scanned.length === 0) {
      throw new CliError("MEDIA_FOLDER_INVALID", `La carpeta de medios está vacía: ${media.path}`);
    }
    const entries = [];
    for (const file of scanned) {
      const sha256 = await sha256Of(file.path);
      files.set(uploadKey({ kind: "file", name: file.rel }), {
        path: file.path,
        size: file.size,
        sha256,
      });
      entries.push({ path: file.rel, size: file.size, sha256 });
    }
    request.media = {
      kind: "folder",
      name: posix.basename(media.path.split(sep).join(posix.sep)) || "medios",
      files: entries,
    };
  }
  return { request, files };
}

/** Un `PUT` a R2 que no llegó a buen término: `status` si hubo respuesta, y el código S3 si vino. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly s3Code?: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export type PutRequest = {
  url: string;
  headers: Record<string, string>;
  file: LocalUpload;
  /** Bytes enviados desde el último aviso (para el avance). */
  onProgress(bytes: number): void;
};

/** Sube un archivo con su URL prefirmada; lanza `UploadError` si no se pudo. */
export type PutFile = (request: PutRequest) => Promise<void>;

/** Sin un byte en este tiempo, el `PUT` se corta (y se reintenta). */
export const PUT_IDLE_TIMEOUT_MS = 60_000;

/**
 * El `PUT` con `node:http(s)`: el archivo en streaming, con `Content-Length` (R2 no acepta un cuerpo
 * sin largo, y la firma lo incluye) y las cabeceras firmadas tal cual.
 */
export function createNodePutFile(options: { idleTimeoutMs?: number } = {}): PutFile {
  const idleTimeoutMs = options.idleTimeoutMs ?? PUT_IDLE_TIMEOUT_MS;
  return ({ url, headers, file, onProgress }) =>
    new Promise<void>((resolve, reject) => {
      const target = new URL(url);
      const client = target.protocol === "https:" ? https : http;
      const request = client.request(
        target,
        { method: "PUT", headers: { ...headers, "content-length": String(file.size) } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            if (body.length < 4000) body += chunk;
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve();
              return;
            }
            const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
            reject(
              new UploadError(`R2 respondió ${status}${code ? ` (${code})` : ""}`, status, code),
            );
          });
          response.on("error", (error) => reject(new UploadError(error.message)));
        },
      );
      request.setTimeout(idleTimeoutMs, () => {
        request.destroy(new Error(`sin respuesta en ${Math.round(idleTimeoutMs / 1000)} s`));
      });
      const stream = createReadStream(file.path);
      request.on("error", (error) => {
        stream.destroy();
        reject(new UploadError(error.message));
      });
      stream.on("data", (chunk) => onProgress(chunk.length));
      stream.on("error", (error) => request.destroy(error));
      stream.pipe(request);
    });
}

/** Se reintenta una red caída, un corte, un 5xx o un 429; un 4xx (firma, sha256, largo) no. */
const isRetriable = (error: unknown) =>
  !(error instanceof UploadError) ||
  error.status === undefined ||
  error.status >= 500 ||
  error.status === 429;

export type UploadProgress = {
  sentBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
};

export type UploadAllOptions = {
  putFile: PutFile;
  sleep: (ms: number) => Promise<void>;
  /** Intentos por archivo (por defecto 3). */
  attempts?: number;
  /** Archivos a la vez (por defecto 4). */
  concurrency?: number;
  onProgress?: (progress: UploadProgress) => void;
};

/**
 * Sube todos los archivos de la carga con sus URLs, de a `concurrency`, y reintenta cada uno hasta
 * `attempts` veces (1 s, 2 s…) si el fallo es pasajero. Si un archivo no se puede subir, corta con
 * un `CliError` que nombra el archivo (nunca la URL) y no empieza la carga.
 */
export async function uploadAll(
  targets: readonly ImportUploadTargetView[],
  files: ReadonlyMap<string, LocalUpload>,
  options: UploadAllOptions,
): Promise<void> {
  const attempts = options.attempts ?? 3;
  const queue = targets.map((target) => {
    const file = files.get(uploadKey(target));
    if (file === undefined) {
      throw new CliError(
        "IMPORT_UPLOAD_INVALID",
        `La API pidió un archivo que no está: ${target.name}`,
      );
    }
    return { target, file };
  });
  const progress: UploadProgress = {
    sentBytes: 0,
    totalBytes: queue.reduce((total, { file }) => total + file.size, 0),
    doneFiles: 0,
    totalFiles: queue.length,
  };
  let failure: CliError | undefined;

  async function uploadOne({ target, file }: (typeof queue)[number]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      let sent = 0;
      try {
        await options.putFile({
          url: target.url,
          headers: target.headers,
          file,
          onProgress: (bytes) => {
            sent += bytes;
            progress.sentBytes += bytes;
            options.onProgress?.(progress);
          },
        });
        progress.doneFiles += 1;
        options.onProgress?.(progress);
        return;
      } catch (error) {
        progress.sentBytes -= sent;
        if (attempt >= attempts || !isRetriable(error)) {
          const reason = error instanceof Error ? error.message : String(error);
          const changed = error instanceof UploadError && error.s3Code === "BadDigest";
          const forbidden = error instanceof UploadError && error.status === 403;
          throw new CliError(
            "IMPORT_UPLOAD_FAILED",
            `No se pudo subir ${target.name}: ${changed ? "el archivo cambió mientras se subía" : reason}`,
            forbidden
              ? "La URL de subida venció o no calza (dura 6 h): vuelve a correr el comando"
              : "Revisa tu conexión y vuelve a correr el comando",
          );
        }
        await options.sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  let next = 0;
  const worker = async () => {
    while (failure === undefined && next < queue.length) {
      const item = queue[next];
      next += 1;
      if (item === undefined) return;
      await uploadOne(item).catch((error: unknown) => {
        failure ??=
          error instanceof CliError ? error : new CliError("IMPORT_UPLOAD_FAILED", String(error));
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 4, queue.length) }, worker),
  );
  if (failure !== undefined) throw failure;
}
