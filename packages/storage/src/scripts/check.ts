import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createLogger, loadEnv, loadEnvFile, panelUrlOf } from "@agentsales/config";
import { CHECKSUM_SHA256_HEADER, createR2Storage } from "../r2-storage.js";

// Sube, lee, prueba una URL prefirmada y borra un objeto de prueba en el bucket de R2. Desde F8
// (spec F8 §4.4, ADR-0025) también sube con una URL prefirmada de PUT (y comprueba que R2 rechaza
// otro contenido u otro largo), lista por prefijo y revisa la regla de CORS del bucket para el
// panel (`http://localhost:<WEB_PORT>` en desarrollo, `PUBLIC_URL` si está, u otro con `--origin`,
// por ejemplo `ENV_FILE=.env.production pnpm storage:check --origin https://agentsales.agentpey.com`).
// Nunca imprime credenciales ni las URLs prefirmadas (la firma da acceso).
const { values: args } = parseArgs({ options: { origin: { type: "string" } } });
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
const streamPath = `_healthcheck/${randomUUID()}.bin`;
/** 1 MB en trozos de 64 KB, como un video leído del disco (`putStream`, spec F1 D3). */
const STREAM_BYTES = 1024 * 1024;
const STREAM_CHUNK = 64 * 1024;
const streamData = Uint8Array.from({ length: STREAM_BYTES }, (_, index) => (index * 31) % 256);
async function* streamChunks(): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < STREAM_BYTES; offset += STREAM_CHUNK) {
    yield streamData.subarray(offset, offset + STREAM_CHUNK);
  }
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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
let streamUploaded = false;
const presignedPath = `_healthcheck/${randomUUID()}.bin`;
let presignedUploaded = false;
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

  await storage.putStream(streamPath, streamChunks(), {
    contentType: "application/octet-stream",
    contentLength: STREAM_BYTES,
  });
  streamUploaded = true;
  const streamed = await storage.get(streamPath);
  check(
    streamed.byteLength === STREAM_BYTES && sha256(streamed) === sha256(streamData),
    "subir en streaming (1 MB, mismo sha256)",
  );

  // Lectura en streaming (F2-T03): mismo contenido, en varios trozos y sin cargarlo de una vez.
  const parts: Uint8Array[] = [];
  for await (const part of await storage.getStream(streamPath)) parts.push(part);
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  check(
    joined.byteLength === STREAM_BYTES && sha256(joined) === sha256(streamData),
    `leer en streaming (${parts.length} trozos, mismo sha256)`,
  );
  const missing = await storage.getStream(`${streamPath}.no-existe`).then(
    () => "sin error",
    (error: unknown) =>
      error instanceof Error && "code" in error ? String(error.code) : String(error),
  );
  check(missing === "STORAGE_NOT_FOUND", `leer en streaming un objeto inexistente → ${missing}`);
  await storage.delete(streamPath);
  streamUploaded = false;

  // Con sha256 (F1-T07b): el correcto se acepta y uno de otro contenido se rechaza sin guardar.
  await storage.putStream(streamPath, streamChunks(), {
    contentType: "application/octet-stream",
    contentLength: STREAM_BYTES,
    sha256: sha256(streamData),
  });
  streamUploaded = true;
  check(sha256(await storage.get(streamPath)) === sha256(streamData), "subir con sha256 correcto");
  await storage.delete(streamPath);
  streamUploaded = false;

  const rejected = await storage
    .putStream(streamPath, streamChunks(), {
      contentType: "application/octet-stream",
      contentLength: STREAM_BYTES,
      sha256: sha256(new TextEncoder().encode("otro contenido")),
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  streamUploaded = rejected === null;
  const rejectedCode =
    rejected instanceof Error && "code" in rejected ? String(rejected.code) : String(rejected);
  check(
    rejectedCode === "STORAGE_CONTENT_MISMATCH",
    `sha256 de otro contenido → rechazado (${rejectedCode})`,
  );
  check((await storage.head(streamPath)) === null, "el rechazado no quedó guardado");

  // Subida directa con una URL prefirmada de PUT (F8-T03): la del panel y la CLI.
  const small = streamData.subarray(0, 64 * 1024);
  const signUpload = (sha256Hex?: string) =>
    storage.signedUploadUrl(presignedPath, {
      contentType: "application/octet-stream",
      contentLength: small.byteLength,
      ...(sha256Hex === undefined ? {} : { sha256: sha256Hex }),
      ttlSeconds: 300,
    });
  const putSigned = async (
    upload: { url: string; headers: Record<string, string> },
    body: Uint8Array,
  ) =>
    (
      await fetch(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    ).status;

  const good = await signUpload(sha256(small));
  const goodStatus = await putSigned(good, small);
  presignedUploaded = goodStatus === 200;
  check(goodStatus === 200, `PUT prefirmado con sha256 (${goodStatus})`);
  check(sha256(await storage.get(presignedPath)) === sha256(small), "lo subido es lo firmado");
  const listed = await storage.list("_healthcheck/");
  check(
    listed.some((object) => object.path === presignedPath && object.size === small.byteLength),
    `listar por prefijo (${listed.length} objeto(s))`,
  );
  await storage.delete(presignedPath);
  presignedUploaded = false;

  // Otro contenido del mismo largo: R2 debe rechazarlo por el sha256 (esto es lo NO VERIFICADO de
  // la nota r2-checksums y del spec F8 §4.4). Si lo acepta, el worker sigue validando lo que lee.
  const altered = small.slice();
  altered[0] = (altered[0] ?? 0) ^ 0xff;
  const tamperedStatus = await putSigned(await signUpload(sha256(small)), altered);
  presignedUploaded = tamperedStatus === 200;
  check(
    tamperedStatus === 400 && (await storage.head(presignedPath)) === null,
    `PUT prefirmado con otro contenido → rechazado (${tamperedStatus})`,
  );
  // Otro largo: no calza con la firma.
  const longerStatus = await putSigned(
    await signUpload(),
    streamData.subarray(0, small.byteLength + 1),
  );
  presignedUploaded = longerStatus === 200;
  check(
    [400, 403].includes(longerStatus) && (await storage.head(presignedPath)) === null,
    `PUT prefirmado con otro largo → rechazado (${longerStatus})`,
  );

  // La regla de CORS del bucket (la pone el operador; checklist "Antes de F8"): el navegador
  // pregunta antes del PUT si el panel puede subir con esas cabeceras.
  const panelOrigin = new URL(args.origin ?? panelUrlOf(env)).origin;
  const preflight = await fetch((await signUpload(sha256(small))).url, {
    method: "OPTIONS",
    headers: {
      Origin: panelOrigin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": `content-type,${CHECKSUM_SHA256_HEADER}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const allowOrigin = preflight.headers.get("access-control-allow-origin");
  const allowMethods = preflight.headers.get("access-control-allow-methods") ?? "";
  check(
    preflight.ok &&
      (allowOrigin === panelOrigin || allowOrigin === "*") &&
      /\bPUT\b/i.test(allowMethods),
    `CORS: PUT desde ${panelOrigin} con content-type y ${CHECKSUM_SHA256_HEADER} (${preflight.status})`,
  );

  logger.info("storage:check OK");
} catch (error) {
  logger.error({ err: error }, "storage:check falló");
  process.exitCode = 1;
} finally {
  for (const [pending, objectPath] of [
    [uploaded, path],
    [streamUploaded, streamPath],
    [presignedUploaded, presignedPath],
  ] as const) {
    if (!pending) continue;
    await storage.delete(objectPath).catch((error: unknown) => {
      logger.warn(
        { err: error, objectPath },
        "no se pudo borrar el objeto de prueba; bórralo a mano",
      );
    });
  }
}
