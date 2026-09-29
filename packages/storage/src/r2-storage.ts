import { AppError, type MediaStorage, type StoredObjectInfo } from "@agentsales/core";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
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

  return {
    async put(path, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: path, Body: body, ContentType: contentType }),
      );
    },

    async get(path) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
      if (!response.Body) {
        throw new AppError("STORAGE_EMPTY_BODY", `El objeto ${path} vino sin contenido`);
      }
      return response.Body.transformToByteArray();
    },

    async head(path): Promise<StoredObjectInfo | null> {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: path }));
        return { size: response.ContentLength ?? 0, contentType: response.ContentType };
      } catch (error) {
        if (error instanceof NotFound || isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },

    async delete(path) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
    },

    signedReadUrl(path, ttlSeconds = signedUrlTtlSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: path }), {
        expiresIn: ttlSeconds,
      });
    },
  };
}

/** HEAD no trae cuerpo: según la versión del SDK, el 404 llega como `NotFound` o solo con status. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return false;
  }
  const metadata = error.$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 404
  );
}
