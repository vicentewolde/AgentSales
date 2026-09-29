import { randomUUID } from "node:crypto";
import { createLogger, loadEnv, loadEnvFile } from "@agentsales/config";
import { createR2Storage } from "../r2-storage.js";

// Sube, lee, prueba una URL prefirmada y borra un objeto de prueba en el bucket de R2.
// Nunca imprime credenciales ni la URL prefirmada (la firma da acceso de lectura).
loadEnvFile();
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });
const storage = createR2Storage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
});

const path = `_healthcheck/${randomUUID()}.txt`;
const content = `agentsales storage:check ${new Date().toISOString()}`;
const expected = new TextEncoder().encode(content);

function check(ok: boolean, step: string): void {
  if (!ok) {
    throw new Error(`Falló: ${step}`);
  }
  logger.info(`✓ ${step}`);
}

const FETCH_TIMEOUT_MS = 15_000;

let uploaded = false;
try {
  logger.info({ bucket: env.R2_BUCKET, path }, "probando el bucket de R2");

  await storage.put(path, expected, "text/plain; charset=utf-8");
  uploaded = true;
  check(true, "subir objeto");

  const read = new TextDecoder().decode(await storage.get(path));
  check(read === content, "leer objeto");

  const info = await storage.head(path);
  check(info?.size === expected.byteLength, "leer metadatos");

  const signedUrl = await storage.signedReadUrl(path, 60);
  const response = await fetch(signedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  check(response.status === 200 && (await response.text()) === content, "URL prefirmada (200)");

  // La misma URL sin firma debe rechazarse. Esto prueba el endpoint S3; el acceso público de R2
  // va por r2.dev o un dominio propio, y se verifica a mano (docs/09-alta-neon-r2.md).
  const unsigned = new URL(signedUrl);
  unsigned.search = "";
  const anonymous = await fetch(unsigned, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  check([400, 401, 403].includes(anonymous.status), `sin firma → rechazado (${anonymous.status})`);

  await storage.delete(path);
  uploaded = false;
  check((await storage.head(path)) === null, "borrar objeto");

  logger.info("storage:check OK");
} catch (error) {
  logger.error({ err: error }, "storage:check falló");
  process.exitCode = 1;
} finally {
  if (uploaded) {
    await storage.delete(path).catch((error: unknown) => {
      logger.warn({ err: error, path }, "no se pudo borrar el objeto de prueba; bórralo a mano");
    });
  }
}
