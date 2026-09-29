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

/** Adaptador de `MediaStorage` para Cloudflare R2 vía la API S3 (ADR-0007). */
export function createR2Storage(options: R2StorageOptions): MediaStorage {
  const { bucket, signedUrlTtlSeconds } = options;
  const client = new S3Client({
    region: "auto",
    endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
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
