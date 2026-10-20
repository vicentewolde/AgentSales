import { postOriginalPath, postOriginalsPrefix } from "../content/media-keys.js";
import type { MediaKind } from "../enums.js";
import { AppError } from "../errors.js";
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
// A diferencia de la carga, **cada archivo trae su sha256**: es su identidad. Va en la clave
// (`posts/{postId}/original/{sha256}.{ext}`, como los originales de un aviso), así el mismo archivo
// pedido dos veces es la misma subida, y un original ya guardado no se vuelve a subir (el único
// `(post_id, checksum)` de `media`).

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

/** Un archivo pedido: su nombre (para mostrarlo), su tamaño exacto y su sha256 en hexadecimal. */
export type PostUploadFile = { name: string; size: number; sha256: string };

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
  sha256: string;
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
  const sha256 = file.sha256.toLowerCase();
  if (!SHA256_HEX.test(sha256)) throw invalid(`${short}: sha256 inválido`, { name: short });
  return { name, size: file.size, sha256, ...type };
}

export type RequestPostUploadsDeps = {
  posts: Pick<PostRepository, "get">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "signedUploadUrl">;
  /** `MAX_IMPORT_UPLOAD_MB` en bytes: el tope de cada archivo (el de la carga). */
  maxFileBytes: number;
  /** `MAX_VIDEO_MB` en bytes: el tope de un video (el de la carga, spec F1, D3). */
  maxVideoBytes: number;
  now?: () => Date;
};

/**
 * Pide las URLs de subida de los medios de un post (`POST /api/posts/:id/uploads`, ADR-0025). Por
 * cada archivo: si ese contenido ya es un medio del post, `existing`; si no, una URL de `PUT` de
 * 6 h firmada con su tipo, su tamaño y su sha256, y su fila en `post_uploads` (pendiente, vence a
 * las 24 h). Pedir otra vez el mismo archivo (una URL vencida, un reintento) reabre su subida con
 * la misma clave. Dos nombres con el mismo contenido son una sola subida. Firmar no habla con R2.
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
  // Un contenido, una subida: el primero de cada sha256 decide la clave.
  const unique = new Map<string, CheckedFile>();
  for (const file of checked) if (!unique.has(file.sha256)) unique.set(file.sha256, file);

  // Se firma antes del candado (firmar no habla con R2, pero el candado no espera a nadie).
  const signed = new Map<string, { key: string; upload: SignedUpload }>();
  for (const file of unique.values()) {
    const key = postOriginalPath(postId, file.sha256, file.extension);
    const upload = await deps.storage.signedUploadUrl(key, {
      contentType: file.mime,
      contentLength: file.size,
      sha256: file.sha256,
      ttlSeconds: POST_UPLOAD.urlTtlSeconds,
    });
    signed.set(file.sha256, { key, upload });
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
    // Lo que ya ocupa un lugar: los medios guardados y las subidas pendientes que no se repiten.
    const pendingOthers = uploads.filter(
      (upload) => upload.status === "pending" && !requested.has(upload.objectPath),
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
      const upload =
        previous === undefined
          ? await postUploads.create({
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
    const entry = bySha.get(file.sha256);
    if (entry !== undefined && "mediaId" in entry) {
      return { status: "existing", name: file.name, mediaId: entry.mediaId };
    }
    const target = signed.get(file.sha256);
    if (entry === undefined || target === undefined) throw postNotFound(postId);
    return { status: "upload", name: file.name, uploadId: entry.upload.id, ...target.upload };
  });
  return { post, uploads };
}

/** La clave de un original de un post: su sha256 y su extensión (las que armó `requestPostUploads`). */
const ORIGINAL_KEY = /^posts\/[^/]+\/original\/([0-9a-f]{64})\.([a-z0-9]+)$/;

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
  /** Los originales del post, en orden. */
  media: MediaRecord[];
};

/**
 * Termina las subidas de un post (`POST /api/posts/:id/uploads/complete`): revisa en R2 (un solo
 * `list`) cuáles de las pendientes llegaron con su tamaño, crea sus medios originales (en el orden
 * en que se pidieron, después de los que ya tenía) y las marca `completed`. Las que faltan siguen
 * pendientes: el cliente las sube y vuelve a llamar (avance y reintento). Si el post tiene medios,
 * encola `post.media` (`singletonKey = postId`) para armar sus variantes; llamar de nuevo con
 * nada pendiente lo vuelve a encolar (repara un encolado que falló), y el job salta lo hecho.
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
    for (const upload of await postUploads.listByPost(postId)) {
      if (upload.status !== "pending") continue;
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
    return { completed, missing, media: await media.listOriginals(postSubject(postId)) };
  });

  if (result.media.length > 0) {
    await deps.queue.enqueue("post.media", { postId }, { singletonKey: postId });
  }
  return { post, ...result };
}

export type CloseAbandonedPostUploadsDeps = {
  postUploads: Pick<PostUploadRepository, "listExpired">;
  postLock: PostLock;
  storage: Pick<MediaStorage, "delete">;
  now?: () => Date;
};

export type CloseAbandonedPostUploadsResult = {
  /** Subidas cerradas como `abandoned` (su objeto ya se borró de R2). */
  abandoned: string[];
  /** Subidas que no se pudieron borrar o cerrar: siguen pendientes y vuelven en la próxima vuelta. */
  failed: string[];
};

/**
 * La limpieza de las subidas de posts (en `publications.watch`, cada hora, como la de las cargas):
 * cada subida pendiente vencida (24 h) se borra de R2 y queda `abandoned`.
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
  for (const upload of await deps.postUploads.listExpired(now)) {
    try {
      const closed = await deps.postLock.run(upload.postId, async ({ postUploads, media }) => {
        const current = await postUploads.get(upload.id);
        if (current?.status !== "pending" || current.expiresAt >= now) return false;
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
