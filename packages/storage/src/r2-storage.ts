import { Readable } from "node:stream";
import { AppError, isAppError, type MediaStorage, type StoredObjectInfo } from "@agentsales/core";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type R2StorageOptions = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** TTL por defecto de las URLs prefirmadas (máximo 7 días, ADR-0007). */
  signedUrlTtlSeconds: number;
  /** Solo para tests: por defecto `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint?: string;
};

/**
 * Código S3 del error (`BadDigest`…). El SDK lo pone en `name` y también en `Code`; se miran los
 * dos, por si una versión deja de copiarlo a `name` (el test msw lo detectaría igual).
 */
function s3ErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("Code" in error && typeof error.Code === "string") return error.Code;
  return error instanceof Error ? error.name : undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** `ChecksumSHA256` va en base64 del digest crudo, no en hexadecimal. */
const sha256Base64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

/** Status HTTP de un error del SDK, si lo trae. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  if (typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata) {
    return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
  }
  return undefined;
}

/**
 * Traduce un error del SDK a `AppError` para que nada fuera de este paquete dependa del SDK:
 * - 404 → `STORAGE_NOT_FOUND` (no reintentable);
 * - 5xx, 429 o sin respuesta (red, DNS, timeout) → `STORAGE_UNAVAILABLE` (reintentable);
 * - el resto (credenciales, permisos, bucket inexistente) → `STORAGE_ERROR` (no reintentable).
 */
function toAppError(error: unknown, path: string): AppError {
  const status = httpStatusOf(error);
  // R2 recalcula el sha256 de lo recibido y no guarda el objeto si no calza con `ChecksumSHA256`.
  if (s3ErrorCode(error) === "BadDigest") {
    return new AppError(
      "STORAGE_CONTENT_MISMATCH",
      `El contenido subido a ${path} no calza con su sha256`,
      { details: { path, status }, cause: error },
    );
  }
  if (status === 404) {
    return new AppError("STORAGE_NOT_FOUND", `No existe el objeto ${path}`, {
      details: { path },
      cause: error,
    });
  }
  if (status === undefined || status >= 500 || status === 429) {
    return new AppError("STORAGE_UNAVAILABLE", `R2 no respondió al acceder a ${path}`, {
      retriable: true,
      details: { path, status },
      cause: error,
    });
  }
  return new AppError("STORAGE_ERROR", `R2 rechazó la operación sobre ${path} (${status})`, {
    details: { path, status },
    cause: error,
  });
}

/**
 * Recorre el stream contando bytes. Ante un problema del archivo de origen avisa con `onFailure` y
 * **termina sin lanzar**: un error lanzado aquí no corta la petición (queda colgada) y sale como
 * evento `error` del `Readable`. Quien llama aborta la petición y lanza el error:
 * - más o menos bytes que `contentLength`: el archivo cambió mientras se subía
 *   (`STORAGE_CONTENT_MISMATCH`, no reintentable: es del archivo, no de R2);
 * - un error al leerlo: un `AppError` del lector (por ejemplo, de la ingesta de medios) pasa tal
 *   cual, con su código y si es reintentable; cualquier otro error se envuelve en `STORAGE_ERROR`.
 */
async function* counted(
  body: AsyncIterable<Uint8Array>,
  expected: number,
  path: string,
  onFailure: (error: AppError) => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  const mismatch = () =>
    onFailure(
      new AppError(
        "STORAGE_CONTENT_MISMATCH",
        `El archivo ${path} cambió mientras se subía (se esperaban ${expected} bytes)`,
        { details: { path, expected, received: total } },
      ),
    );
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > expected) {
        mismatch();
        return;
      }
      yield chunk;
    }
  } catch (error) {
    onFailure(readFailure(error, path));
    return;
  }
  if (total !== expected) mismatch();
}

/** Error al leer el archivo de origen: un `AppError` del lector pasa tal cual. */
function readFailure(error: unknown, path: string): AppError {
  return isAppError(error)
    ? error
    : new AppError("STORAGE_ERROR", `No se pudo leer el archivo para subir ${path}`, {
        details: { path },
        cause: error,
      });
}

/**
 * El cuerpo de un `GetObject` como iterable de bytes. Un corte a mitad de la lectura sale como
 * `AppError` (`toAppError`: sin respuesta HTTP es `STORAGE_UNAVAILABLE`, reintentable), no como el
 * error crudo del socket.
 */
export async function* readBody(
  body: AsyncIterable<Uint8Array>,
  path: string,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) yield chunk;
  } catch (error) {
    throw toAppError(error, path);
  }
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

/** Destruye el `Readable` del SDK (libera el socket); no hace nada si el cuerpo no lo permite. */
function destroyBody(body: object): void {
  if ("destroy" in body && typeof body.destroy === "function") body.destroy();
}

/**
 * Envuelve el cuerpo de un `GetObject` (spec F2 §4.2) para que la conexión se libere siempre: al
 * terminar de leer, ante un error, al dejar de iterar y también con `return()` sin haber leído
 * nada (un generador sin arrancar no ejecuta su `finally`, y el socket quedaría tomado). R2 sin
 * cuerpo es `STORAGE_UNAVAILABLE`, reintentable: entregar un iterable vacío haría pasar un video
 * por uno de 0 bytes. `onRelease` corre una sola vez.
 */
export function streamFromBody(
  body: unknown,
  path: string,
  onRelease: () => void = () => {},
): AsyncIterable<Uint8Array> {
  if (!isAsyncIterable(body)) {
    throw new AppError("STORAGE_UNAVAILABLE", `R2 no devolvió el contenido de ${path}`, {
      retriable: true,
      details: { path },
    });
  }
  const chunks = readBody(body, path);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    destroyBody(body);
    onRelease();
  };
  return {
    [Symbol.asyncIterator]: () => ({
      async next() {
        try {
          const result = await chunks.next();
          if (result.done) release();
          return result;
        } catch (error) {
          release();
          throw error;
        }
      },
      async return() {
        release();
        await chunks.return(undefined);
        return { done: true, value: undefined };
      },
    }),
  };
}

/** Adaptador de `MediaStorage` para Cloudflare R2 vía la API S3 (ADR-0007). */
export function createR2Storage(options: R2StorageOptions): MediaStorage {
  const { bucket, signedUrlTtlSeconds } = options;
  const clientConfig = {
    region: "auto",
    endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  };
  const client = new S3Client(clientConfig);
  // Cliente aparte para streams:
  // - un solo intento: el SDK no puede rebobinar el cuerpo. Hoy el SDK ya no reintenta un cuerpo
  //   que es stream, así que `maxAttempts: 1` es **defensivo**, por si eso cambia en otra versión.
  //   El reintento es del job, que vuelve a abrir el archivo (spec F1, D3);
  // - sin checksum por defecto: con él, el SDK manda el stream en `aws-chunked` con un CRC32 al
  //   final y sin `Content-Length`, un formato del que no queremos depender en R2. Queda un PUT
  //   normal con `Content-Length`. Con `sha256`, se manda como `ChecksumSHA256` (sin
  //   `ChecksumAlgorithm`): el SDK deja el header tal cual, sin `aws-chunked`, y R2 rechaza con
  //   `BadDigest` un contenido que no calza (F1-T07b, `docs/integraciones/r2-checksums.md`).
  const streamClient = new S3Client({
    ...clientConfig,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  async function send<T>(path: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toAppError(error, path);
    }
  }

  return {
    put(path, body, contentType) {
      return send(path, async () => {
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: path, Body: body, ContentType: contentType }),
        );
      });
    },

    async putStream(path, body, { contentType, contentLength, sha256 }) {
      // Un largo o un sha256 inválidos son un bug de quien llama: sin esto saldrían como
      // reintentables o como un `InvalidDigest` de R2.
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new AppError(
          "STORAGE_ERROR",
          `contentLength inválido para ${path}: ${contentLength}`,
          {
            details: { path, contentLength },
          },
        );
      }
      if (sha256 !== undefined && !SHA256_HEX.test(sha256)) {
        throw new AppError("STORAGE_ERROR", `sha256 inválido para ${path}`, {
          details: { path },
        });
      }
      let failure: AppError | undefined;
      // Un problema del archivo de origen no corta la petición por sí solo: se aborta a mano.
      const abort = new AbortController();
      const stream = Readable.from(
        counted(body, contentLength, path, (error) => {
          failure = error;
          abort.abort(error);
        }),
      );
      // Red de seguridad: `counted` no lanza, pero si el `Readable` igual fallara, se registra el
      // error y se aborta la petición (el pipe no lo propaga y quedaría colgada).
      stream.on("error", (error) => {
        failure ??= readFailure(error, path);
        abort.abort(failure);
      });
      try {
        await send(path, async () => {
          await streamClient.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: path,
              Body: stream,
              ContentLength: contentLength,
              ContentType: contentType,
              ...(sha256 === undefined ? {} : { ChecksumSHA256: sha256Base64(sha256) }),
            }),
            { abortSignal: abort.signal },
          );
        });
      } catch (error) {
        throw failure ?? error;
      } finally {
        stream.destroy();
      }
    },

    get(path) {
      return send(path, async () => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
        return response.Body ? response.Body.transformToByteArray() : new Uint8Array();
      });
    },

    async getStream(path, { signal } = {}) {
      // La señal de quien llama (`AbortSignalLike`, de core) corta la petición y, después, la
      // lectura: un `AbortController` propio la traduce al `AbortSignal` que pide el SDK.
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      if (signal?.aborted) abort.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const stopListening = () => signal?.removeEventListener("abort", onAbort);
      try {
        const response = await send(path, () =>
          client.send(new GetObjectCommand({ Bucket: bucket, Key: path }), {
            abortSignal: abort.signal,
          }),
        );
        // En Node, el cuerpo es un `Readable`: un iterable de `Buffer`, que es un `Uint8Array`.
        const body = response.Body;
        const stream = streamFromBody(body, path, stopListening);
        if (typeof body === "object" && body !== null) {
          abort.signal.addEventListener("abort", () => destroyBody(body), { once: true });
        }
        return stream;
      } catch (error) {
        stopListening();
        throw error;
      }
    },

    async head(path): Promise<StoredObjectInfo | null> {
      try {
        return await send(path, async () => {
          const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: path }));
          return { size: response.ContentLength ?? 0, contentType: response.ContentType };
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "STORAGE_NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },

    delete(path) {
      return send(path, async () => {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
      });
    },

    signedReadUrl(path, ttlSeconds = signedUrlTtlSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: path }), {
        expiresIn: ttlSeconds,
      });
    },
  };
}
