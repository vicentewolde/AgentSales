import { Readable } from "node:stream";
import { AppError, type MediaStorage, type StoredObjectInfo } from "@agentsales/core";
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
 * evento `error` del `Readable`. Quien llama aborta la petición y lanza el `STORAGE_ERROR`:
 * - más o menos bytes que `contentLength`: el archivo cambió mientras se subía;
 * - un error al leerlo (disco, archivo borrado).
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
        "STORAGE_ERROR",
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
    onFailure(
      new AppError("STORAGE_ERROR", `No se pudo leer el archivo para subir ${path}`, {
        details: { path },
        cause: error,
      }),
    );
    return;
  }
  if (total !== expected) mismatch();
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
  // - un solo intento: el SDK no puede rebobinar el cuerpo, así que reintentar mandaría un cuerpo
  //   vacío o cortado. El reintento es del job, que vuelve a abrir el archivo (spec F1, D3);
  // - sin checksum por defecto: con él, el SDK manda el stream en `aws-chunked` con un CRC32 al
  //   final y sin `Content-Length`, un formato del que no queremos depender en R2. Queda un PUT
  //   normal con `Content-Length`; la integridad en tránsito la da TLS, y el sha256 lo calcula la
  //   ingesta (F1-T06).
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

    async putStream(path, body, { contentType, contentLength }) {
      let failure: AppError | undefined;
      // Un problema del archivo de origen no corta la petición por sí solo: se aborta a mano.
      const abort = new AbortController();
      const stream = Readable.from(
        counted(body, contentLength, path, (error) => {
          failure = error;
          abort.abort(error);
        }),
      );
      // Red de seguridad: un error del stream de origen (por ejemplo, el disco) nunca queda sin
      // escuchar; la petición falla igual y `send` lo traduce.
      stream.on("error", () => {});
      try {
        await send(path, async () => {
          await streamClient.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: path,
              Body: stream,
              ContentLength: contentLength,
              ContentType: contentType,
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
