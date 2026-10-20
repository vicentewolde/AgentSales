import type { AbortSignalLike } from "../abort.js";
import { postOriginalPath, postOriginalsPrefix } from "../content/media-keys.js";
import type { MediaKind } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { MediaRecord } from "../ports/media-repository.js";
import type { MediaStorage, SignedUpload } from "../ports/media-storage.js";
import type { PostLock } from "../ports/post-lock.js";
import type { PostRepository, PostUploadRepository } from "../ports/post-repository.js";
import type { Post, PostUpload } from "../post.js";
import { postSubject } from "../subject.js";
import type { User } from "../user.js";
import { assertPostAccess, postNotFound } from "./posts.js";
import { IMPORT_UPLOAD } from "./request-import.js";

// Los medios de un post (spec F9 §4.5, F9-T10), con el modelo de ADR-0025: el panel o la CLI piden
// una URL prefirmada por archivo (`POST /api/posts/:id/uploads`), suben directo a R2 y avisan
// (`…/uploads/complete`); ningún archivo pasa por la API. Lo pendiente vive en `post_uploads`, y la
// limpieza de cada hora borra de R2 lo que nadie terminó de subir.
//
// A diferencia de la carga, **cada archivo de hasta 100 MB trae su sha256**: es su identidad. Va en
// la clave (`posts/{postId}/original/{sha256}.{ext}`, como los originales de un aviso), así el mismo
// archivo pedido dos veces es la misma subida, y un original ya guardado no se vuelve a subir (el
// único `(post_id, checksum)` de `media`).
//
// Sobre 100 MB el sha256 es opcional (F9-T17, ADR-0025 punto 2: el navegador no puede hashear en
// streaming un archivo que no cabe en memoria). Sin él, la clave es la de la subida
// (`posts/{postId}/original/{uploadId}.{ext}`), `complete` la deja `uploaded` y el worker
// (`finalizePostUploads`, en `post.media`) calcula el sha256 en streaming, crea el medio y, si ese
// contenido ya era un medio del post, borra el objeto nuevo.

type Actor = Pick<User, "id" | "role" | "brokerId">;

/** Topes y tiempos de las subidas de un post. */
export const POST_UPLOAD = {
  /** Archivos por pedido, y originales (guardados más pendientes) por post. */
  maxFilesPerRequest: 20,
  maxMediaPerPost: 20,
  /** Las URLs viven lo mismo que las de la carga (6 h); la subida vence a las 24 h. */
  urlTtlSeconds: IMPORT_UPLOAD.urlTtlSeconds,
  abandonedAfterMs: IMPORT_UPLOAD.abandonedAfterMs,
  maxNameBytes: IMPORT_UPLOAD.maxNameBytes,
  /** Hasta este tamaño el sha256 es obligatorio; sobre él, opcional (el de la carga: 100 MB). */
  sha256UpToBytes: IMPORT_UPLOAD.sha256UpToBytes,
} as const;

/**
 * Los tipos que acepta un post: los de la carga (spec F1 §4.3), por extensión. La extensión
 * canónica va en la clave de R2; el tipo, en la URL firmada (el `PUT` debe mandar ese
 * `Content-Type`). Que el contenido calce lo descubre el worker al procesarlo (sharp o ffprobe).
 */
export const POST_MEDIA_TYPES: Readonly<
  Record<string, { kind: MediaKind; mime: string; extension: string }>
> = {
  jpg: { kind: "image", mime: "image/jpeg", extension: "jpg" },
  jpeg: { kind: "image", mime: "image/jpeg", extension: "jpg" },
  png: { kind: "image", mime: "image/png", extension: "png" },
  webp: { kind: "image", mime: "image/webp", extension: "webp" },
  heic: { kind: "image", mime: "image/heic", extension: "heic" },
  mp4: { kind: "video", mime: "video/mp4", extension: "mp4" },
  mov: { kind: "video", mime: "video/quicktime", extension: "mov" },
};

/**
 * Un archivo pedido: su nombre (para mostrarlo), su tamaño exacto y su sha256 en hexadecimal
 * (obligatorio hasta `POST_UPLOAD.sha256UpToBytes`; sobre eso, opcional).
 */
export type PostUploadFile = { name: string; size: number; sha256?: string | undefined };

/**
 * La respuesta por archivo, en el orden pedido: `upload` con su URL de `PUT` (y el id de la subida,
 * para `complete`), o `existing` si ese contenido ya es un medio del post (nada que subir).
 */
export type PostUploadTarget =
  | ({ status: "upload"; name: string; uploadId: string } & SignedUpload)
  | { status: "existing"; name: string; mediaId: string };

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  new AppError("POST_UPLOAD_INVALID", message, { details });

const tooLarge = (message: string, details: Record<string, unknown>) =>
  new AppError("POST_UPLOAD_TOO_LARGE", message, { details });

const postArchived = (postId: string) =>
  new AppError("POST_ARCHIVED", "El post está archivado: ya no recibe medios", {
    details: { postId },
  });

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
// biome-ignore lint/suspicious/noControlCharactersInRegex: justamente se buscan caracteres de control.
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Bytes de un texto en UTF-8 (el tope de nombres es en bytes, como en la carga). */
const byteLength = (text: string) =>
  [...text].reduce((bytes, char) => {
    const code = char.codePointAt(0) ?? 0;
    return bytes + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
  }, 0);

type CheckedFile = {
  name: string;
  size: number;
  /** `null`: un archivo grande sin sha256 (lo calcula el worker). */
  sha256: string | null;
  kind: MediaKind;
  mime: string;
  extension: string;
};

/** Un archivo pedido, validado: nombre sin carpetas, tipo admitido, tamaño y sha256. */
function checkFile(
  file: PostUploadFile,
  caps: { maxFileBytes: number; maxVideoBytes: number },
): CheckedFile {
  const { name } = file;
  const short = name.slice(0, 100);
  if (
    name.trim() === "" ||
    /[\\/]/.test(name) ||
    CONTROL.test(name) ||
    byteLength(name) > POST_UPLOAD.maxNameBytes
  ) {
    throw invalid("Un archivo no tiene un nombre válido", { name: short });
  }
  const dot = name.lastIndexOf(".");
  const type = dot < 0 ? undefined : POST_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()];
  if (type === undefined) {
    throw invalid(`${short}: tipo de archivo no admitido (jpg, png, webp, heic, mp4 o mov)`, {
      name: short,
    });
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw invalid(`${short}: tamaño inválido`, { name: short });
  }
  if (file.size === 0) throw invalid(`${short} está vacío`, { name: short });
  const max =
    type.kind === "video" ? Math.min(caps.maxVideoBytes, caps.maxFileBytes) : caps.maxFileBytes;
  if (file.size > max) {
    throw tooLarge(`${short} pasa de ${mb(max)}`, { name: short, size: file.size, maxBytes: max });
  }
  if (file.sha256 === undefined || file.sha256 === "") {
    if (file.size <= POST_UPLOAD.sha256UpToBytes) {
      throw invalid(`${short}: falta su sha256 (es obligatorio hasta 100 MB)`, { name: short });
    }
    return { name, size: file.size, sha256: null, ...type };
  }
  const sha256 = file.sha256.toLowerCase();
  if (!SHA256_HEX.test(sha256)) throw invalid(`${short}: sha256 inválido`, { name: short });
  return { name, size: file.size, sha256, ...type };
}

/** La identidad de un archivo sin sha256 (en vez del hash): este prefijo y el id de su subida. */
const UPLOAD_IDENTITY = "subida:";
const uploadIdOf = (identity: string) =>
  identity.startsWith(UPLOAD_IDENTITY) ? identity.slice(UPLOAD_IDENTITY.length) : undefined;

export type RequestPostUploadsDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "signedUploadUrl">;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo (el de la carga). */
  maxFileBytes: number;
  /** `MAX_VIDEO_MB` en bytes: el tope de un video (el de la carga, spec F1, D3). */
  maxVideoBytes: number;
  /** El id de una subida sin sha256, que va en su clave (uuid, como Postgres). */
  newId: () => string;
  now?: () => Date;
};

/**
 * Pide las URLs de subida de los medios de un post (`POST /api/posts/:id/uploads`, ADR-0025). Por
 * cada archivo: si ese contenido ya es un medio del post, `existing`; si no, una URL de `PUT` de
 * 6 h firmada con su tipo, su tamaño y su sha256, y su fila en `post_uploads` (pendiente, vence a
 * las 24 h). Pedir otra vez el mismo archivo (una URL vencida, un reintento) reabre su subida con
 * la misma clave. Dos nombres con el mismo contenido son una sola subida. Un archivo de más de
 * 100 MB sin sha256 es siempre una subida nueva, con la clave de su id (F9-T17): pedirlo otra vez
 * deja la anterior pendiente hasta que la limpieza la abandone. Firmar no habla con R2.
 * Errores: `POST_UPLOAD_INVALID` (400), `POST_UPLOAD_TOO_LARGE` (413), `POST_ARCHIVED` (409).
 */
export async function requestPostUploads(
  deps: RequestPostUploadsDeps,
  actor: Actor,
  postId: string,
  files: readonly PostUploadFile[],
): Promise<{ post: Post; uploads: PostUploadTarget[] }> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (post.status === "archived") throw postArchived(postId);
  if (files.length === 0) throw invalid("No hay archivos que subir");
  if (files.length > POST_UPLOAD.maxFilesPerRequest) {
    throw invalid(`Se suben hasta ${POST_UPLOAD.maxFilesPerRequest} archivos por vez`, {
      files: files.length,
    });
  }
  const checked = files.map((file) => checkFile(file, deps));
  // Un contenido, una subida: el primero de cada sha256 decide la clave. Un archivo sin sha256 es
  // su propia subida (su identidad es el id de la subida, que va en la clave).
  const identityOf = new Map<CheckedFile, string>();
  const unique = new Map<string, CheckedFile>();
  for (const file of checked) {
    const identity = file.sha256 ?? `${UPLOAD_IDENTITY}${deps.newId()}`;
    identityOf.set(file, identity);
    if (!unique.has(identity)) unique.set(identity, file);
  }

  // Se firma antes del candado (firmar no habla con R2, pero el candado no espera a nadie).
  const signed = new Map<string, { key: string; upload: SignedUpload }>();
  for (const [identity, file] of unique) {
    const key = postOriginalPath(postId, uploadIdOf(identity) ?? identity, file.extension);
    const upload = await deps.storage.signedUploadUrl(key, {
      contentType: file.mime,
      contentLength: file.size,
      ...(file.sha256 === null ? {} : { sha256: file.sha256 }),
      ttlSeconds: POST_UPLOAD.urlTtlSeconds,
    });
    signed.set(identity, { key, upload });
  }
  const expiresAt = new Date(
    (deps.now ?? (() => new Date()))().getTime() + POST_UPLOAD.abandonedAfterMs,
  );

  const bySha = await deps.postLock.run(postId, async ({ posts, media, postUploads }) => {
    const current = await posts.get(postId);
    if (current === null) throw postNotFound(postId);
    if (current.status === "archived") throw postArchived(postId);
    const originals = new Map(
      (await media.listOriginals(postSubject(postId))).map((item) => [item.checksum, item]),
    );
    const uploads = await postUploads.listByPost(postId);
    const byPath = new Map(uploads.map((upload) => [upload.objectPath, upload]));
    const requested = new Set(
      [...signed].filter(([sha]) => !originals.has(sha)).map(([, target]) => target.key),
    );
    // Lo que ya ocupa un lugar: los medios guardados y las subidas pendientes (o subidas y por
    // revisar en el worker) que no se repiten.
    const pendingOthers = uploads.filter(
      (upload) =>
        (upload.status === "pending" || upload.status === "uploaded") &&
        !requested.has(upload.objectPath),
    ).length;
    if (originals.size + pendingOthers + requested.size > POST_UPLOAD.maxMediaPerPost) {
      throw invalid(`Un post tiene hasta ${POST_UPLOAD.maxMediaPerPost} medios`, {
        maxMedia: POST_UPLOAD.maxMediaPerPost,
      });
    }

    const result = new Map<string, { mediaId: string } | { upload: PostUpload }>();
    for (const [sha, file] of unique) {
      const existing = originals.get(sha);
      if (existing !== undefined) {
        result.set(sha, { mediaId: existing.id });
        continue;
      }
      const key = signed.get(sha)?.key ?? "";
      const previous = byPath.get(key);
      const id = uploadIdOf(sha);
      const upload =
        previous === undefined
          ? await postUploads.create({
              ...(id === undefined ? {} : { id }),
              postId,
              objectPath: key,
              expectedBytes: file.size,
              expiresAt,
            })
          : await postUploads.reopen(previous.id, expiresAt);
      if (upload === null) throw postNotFound(postId);
      result.set(sha, { upload });
    }
    return result;
  });

  const uploads = checked.map((file): PostUploadTarget => {
    const identity = identityOf.get(file) ?? "";
    const entry = bySha.get(identity);
    if (entry !== undefined && "mediaId" in entry) {
      return { status: "existing", name: file.name, mediaId: entry.mediaId };
    }
    const target = signed.get(identity);
    if (entry === undefined || target === undefined) throw postNotFound(postId);
    return { status: "upload", name: file.name, uploadId: entry.upload.id, ...target.upload };
  });
  return { post, uploads };
}

/** La clave de un original de un post: su sha256 y su extensión (las que armó `requestPostUploads`). */
const ORIGINAL_KEY = /^posts\/[^/]+\/original\/([0-9a-f]{64})\.([a-z0-9]+)$/;

/** La clave de un original grande sin sha256: el id de su subida (uuid) y su extensión (F9-T17). */
const UPLOAD_KEY =
  /^posts\/[^/]+\/original\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]+)$/;

/** El tipo de un original por la extensión de su clave (`undefined` si no es de un original). */
const typeOfKey = (objectPath: string) => {
  const extension = (ORIGINAL_KEY.exec(objectPath) ?? UPLOAD_KEY.exec(objectPath))?.[2];
  return extension === undefined ? undefined : POST_MEDIA_TYPES[extension];
};

export type CompletePostUploadsDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "list">;
  queue: JobQueue;
};

export type CompletePostUploadsResult = {
  post: Post;
  /** Subidas que llegaron completas y quedaron como medios (o ya lo eran). */
  completed: string[];
  /** Subidas pendientes cuyo archivo todavía no está en R2 (o tiene otro tamaño). */
  missing: string[];
  /**
   * Subidas grandes sin sha256 que llegaron completas (F9-T17): quedan `uploaded` y el worker las
   * hashea, crea su medio y deduplica (`post.media`).
   */
  uploaded: string[];
  /** Los originales del post, en orden. */
  media: MediaRecord[];
};

/**
 * Termina las subidas de un post (`POST /api/posts/:id/uploads/complete`): revisa en R2 (un solo
 * `list`) cuáles de las pendientes llegaron con su tamaño, crea sus medios originales (en el orden
 * en que se pidieron, después de los que ya tenía) y las marca `completed`. Las que faltan siguen
 * pendientes: el cliente las sube y vuelve a llamar (avance y reintento). Una subida grande sin
 * sha256 que llegó queda `uploaded` (F9-T17): su medio lo crea el worker. Si el post tiene medios o
 * subidas `uploaded`, encola `post.media` (`singletonKey = postId`) para armar sus variantes;
 * llamar de nuevo con nada pendiente lo vuelve a encolar (repara un encolado que falló), y el job
 * salta lo hecho.
 */
export async function completePostUploads(
  deps: CompletePostUploadsDeps,
  actor: Actor,
  postId: string,
): Promise<CompletePostUploadsResult> {
  const post = assertPostAccess(actor, await deps.posts.get(postId), postId);
  if (post.status === "archived") throw postArchived(postId);
  const listed = new Map(
    (await deps.storage.list(postOriginalsPrefix(postId))).map((object) => [
      object.path,
      object.size,
    ]),
  );

  const result = await deps.postLock.run(postId, async ({ posts, media, postUploads }) => {
    const current = await posts.get(postId);
    if (current === null) throw postNotFound(postId);
    if (current.status === "archived") throw postArchived(postId);
    const originals = await media.listOriginals(postSubject(postId));
    const byChecksum = new Set(originals.map((item) => item.checksum));
    let nextOrder = originals.reduce((max, item) => Math.max(max, item.sortOrder + 1), 0);
    const completed: string[] = [];
    const missing: string[] = [];
    const uploaded: string[] = [];
    let waiting = false;
    for (const upload of await postUploads.listByPost(postId)) {
      if (upload.status === "uploaded") waiting = true;
      if (upload.status !== "pending") continue;
      if (UPLOAD_KEY.test(upload.objectPath)) {
        // Grande y sin sha256: si llegó con su tamaño, la revisa el worker.
        if (
          typeOfKey(upload.objectPath) !== undefined &&
          listed.get(upload.objectPath) === upload.expectedBytes &&
          (await postUploads.markUploaded(upload.id))
        ) {
          uploaded.push(upload.id);
          waiting = true;
        } else missing.push(upload.id);
        continue;
      }
      const match = ORIGINAL_KEY.exec(upload.objectPath);
      const type = match?.[2] === undefined ? undefined : POST_MEDIA_TYPES[match[2]];
      const sha256 = match?.[1];
      if (
        sha256 === undefined ||
        type === undefined ||
        listed.get(upload.objectPath) !== upload.expectedBytes
      ) {
        missing.push(upload.id);
        continue;
      }
      if (!byChecksum.has(sha256)) {
        await media.create({
          listingId: null,
          postId,
          brokerId: current.brokerId,
          kind: type.kind,
          storagePath: upload.objectPath,
          mime: type.mime,
          bytes: upload.expectedBytes,
          checksum: sha256,
          sortOrder: nextOrder++,
          isCover: false,
        });
        byChecksum.add(sha256);
      }
      await postUploads.markCompleted(upload.id);
      completed.push(upload.id);
    }
    return {
      completed,
      missing,
      uploaded,
      waiting,
      media: await media.listOriginals(postSubject(postId)),
    };
  });

  const { waiting, ...rest } = result;
  if (rest.media.length > 0 || waiting) {
    await deps.queue.enqueue("post.media", { postId }, { singletonKey: postId });
  }
  return { post, ...rest };
}

export type CloseAbandonedPostUploadsDeps = {
  postUploads: Pick<PostUploadRepository, "listExpired" | "listStaleUploaded">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "delete">;
  now?: () => Date;
};

/**
 * Cuánto puede quedar una subida `uploaded` sin que el worker la revise (F9-T17): `post.media` la
 * revisa en minutos y agota sus reintentos en menos de una hora; pasadas 24 h desde que llegó, nadie
 * más la va a tomar (salvo otro `complete`), así que la limpieza la cierra como una vencida.
 */
export const STALE_UPLOADED_AFTER_MS = POST_UPLOAD.abandonedAfterMs;

export type CloseAbandonedPostUploadsResult = {
  /** Subidas cerradas como `abandoned` (su objeto ya se borró de R2). */
  abandoned: string[];
  /** Subidas que no se pudieron borrar o cerrar: siguen pendientes y vuelven en la próxima vuelta. */
  failed: string[];
};

/**
 * La limpieza de las subidas de posts (en `publications.watch`, cada hora, como la de las cargas):
 * cada subida pendiente vencida (24 h) se borra de R2 y queda `abandoned`. Desde F9-T17, también
 * cada `uploaded` que lleva más de 24 h así (el worker agotó sus reintentos sin revisarla), con la
 * misma revisión en el candado.
 *
 * Todo pasa dentro del candado del post: se vuelve a leer la subida, se comprueba que siga
 * pendiente y vencida (un pedido nuevo del mismo archivo pudo reabrirla) y que su objeto no sea
 * ya un medio (un `complete` pudo guardarlo), y recién entonces se borra de R2 y se cierra. **Es la
 * excepción a "nada de R2 dentro del candado" (`PostLock`):** hecho afuera, un `complete` o un
 * pedido intercalado entre la revisión y el borrado dejaría un medio guardado sin su objeto. Es una
 * sola llamada (`delete`, idempotente) y la limpieza corre una vez por hora. Si el borrado falla, la
 * transacción no escribe nada: la subida sigue pendiente y vuelve en la próxima vuelta. Si el
 * objeto ya es un medio, la subida solo se marca `completed`.
 */
export async function closeAbandonedPostUploads(
  deps: CloseAbandonedPostUploadsDeps,
): Promise<CloseAbandonedPostUploadsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const abandoned: string[] = [];
  const failed: string[] = [];
  const staleBefore = new Date(now.getTime() - STALE_UPLOADED_AFTER_MS);
  const candidates = [
    ...(await deps.postUploads.listExpired(now)),
    ...(await deps.postUploads.listStaleUploaded(staleBefore)),
  ];
  for (const upload of candidates) {
    try {
      const closed = await deps.postLock.run(upload.postId, async ({ postUploads, media }) => {
        const current = await postUploads.get(upload.id);
        // Sigue como se listó: pendiente y vencida, o subida y sin revisar desde hace 24 h (el
        // worker pudo revisarla entre medio).
        const expired = current?.status === "pending" && current.expiresAt < now;
        const stale = current?.status === "uploaded" && current.updatedAt < staleBefore;
        if (current === null || (!expired && !stale)) return false;
        if ((await media.findByStoragePath(current.objectPath)) !== null) {
          // El archivo ya es un medio (la subida se completó por otro camino): no se abandona.
          await postUploads.markCompleted(current.id);
          return false;
        }
        await deps.storage.delete(current.objectPath);
        return postUploads.markAbandoned(current.id);
      });
      if (closed) abandoned.push(upload.id);
    } catch {
      failed.push(upload.id);
    }
  }
  return { abandoned, failed };
}

export type FinalizePostUploadsDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "getStream" | "delete">;
  /** sha256 hexadecimal de un archivo leído en streaming (core no usa `node:crypto`). */
  sha256Stream: (stream: AsyncIterable<Uint8Array>) => Promise<string>;
};

export type FinalizePostUploadsResult = {
  /** Subidas que quedaron como medios nuevos. */
  created: string[];
  /** Subidas cuyo contenido ya era un medio del post: su objeto se borró de R2. */
  duplicates: string[];
  /** Subidas cuyo archivo ya no estaba en R2: quedan `abandoned`. */
  missing: string[];
};

/**
 * Las subidas grandes sin sha256 de un post (F9-T17, ADR-0025 punto 2), al empezar `post.media`:
 * por cada una en `uploaded`, lee el archivo de R2 en streaming y calcula su sha256 (fuera del
 * candado), y en el candado del post vuelve a mirar que siga `uploaded` y busca ese contenido entre
 * los originales del post. Si no estaba, crea el medio con la clave de la subida y la marca
 * `completed`. Si ya estaba (el único `(post_id, checksum)`), borra de R2 el objeto nuevo (fuera
 * del candado; si falla, el error sube, la subida sigue `uploaded` y el job la reintenta) y recién
 * entonces la marca `completed`. Un archivo que ya no está en R2 deja la subida `abandoned`. Un
 * error de R2 o de la base sube (el job reintenta); al apagar, `MEDIA_ABORTED`.
 */
export async function finalizePostUploads(
  deps: FinalizePostUploadsDeps,
  { postId, signal }: { postId: string; signal?: AbortSignalLike },
): Promise<FinalizePostUploadsResult> {
  const result: FinalizePostUploadsResult = { created: [], duplicates: [], missing: [] };
  if ((await deps.posts.get(postId)) === null) return result;
  const waiting = (
    await deps.postLock.run(postId, ({ postUploads }) => postUploads.listByPost(postId))
  ).filter((upload) => upload.status === "uploaded");

  for (const upload of waiting) {
    if (signal?.aborted) {
      throw new AppError("MEDIA_ABORTED", "Se cortó el procesamiento de medios", {
        retriable: true,
      });
    }
    const type = typeOfKey(upload.objectPath);
    let sha256: string;
    try {
      const stream = await deps.storage.getStream(
        upload.objectPath,
        signal === undefined ? {} : { signal },
      );
      sha256 = (await deps.sha256Stream(stream)).toLowerCase();
    } catch (error) {
      if (!isAppError(error) || error.code !== "STORAGE_NOT_FOUND") throw error;
      await deps.postLock.run(postId, ({ postUploads }) => postUploads.markAbandoned(upload.id));
      result.missing.push(upload.id);
      continue;
    }

    const outcome = await deps.postLock.run(postId, async ({ posts, postUploads, media }) => {
      const current = await postUploads.get(upload.id);
      if (current?.status !== "uploaded") return "skipped" as const;
      const post = await posts.get(postId);
      if (post === null || type === undefined) return "skipped" as const;
      const originals = await media.listOriginals(postSubject(postId));
      if (originals.some((item) => item.checksum === sha256)) return "duplicate" as const;
      await media.create({
        listingId: null,
        postId,
        brokerId: post.brokerId,
        kind: type.kind,
        storagePath: current.objectPath,
        mime: type.mime,
        bytes: current.expectedBytes,
        checksum: sha256,
        sortOrder: originals.reduce((max, item) => Math.max(max, item.sortOrder + 1), 0),
        isCover: false,
      });
      await postUploads.markCompleted(current.id);
      return "created" as const;
    });
    if (outcome === "created") result.created.push(upload.id);
    if (outcome !== "duplicate") continue;
    // El mismo contenido ya es un medio del post: el objeto nuevo sobra. Se borra antes de cerrar la
    // subida, así un fallo la deja `uploaded` y el reintento lo vuelve a intentar.
    await deps.storage.delete(upload.objectPath);
    await deps.postLock.run(postId, ({ postUploads }) => postUploads.markCompleted(upload.id));
    result.duplicates.push(upload.id);
  }
  return result;
}
