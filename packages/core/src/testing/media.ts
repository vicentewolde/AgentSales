import type { MediaKind, MediaRole } from "../enums.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";
import type {
  MediaFile,
  MediaFileSource,
  MediaFolderListing,
  SkippedMediaFile,
} from "../ports/media-file-source.js";
import {
  checkArrangement,
  checkDerivative,
  type MediaRecord,
  type MediaRepository,
  type NewMedia,
} from "../ports/media-repository.js";
import type { MediaStorage, StoredObjectInfo } from "../ports/media-storage.js";
import { structuredCopy } from "./copy.js";

export type InMemoryMediaRepository = MediaRepository & {
  /** Los originales, como `MediaRecord` (lo que ve la carga). */
  all(): MediaRecord[];
  /** Todas las filas: originales, variantes y renders. */
  allMedia(): Media[];
  /** Veces que se llamó a `arrange` (para probar que solo escribe si algo cambió). */
  arrangeCalls(): number;
};

export type InMemoryMediaRepositoryOptions = {
  /** Error para un `create` (por ejemplo, `MEDIA_CONFLICT` o `DB_UNAVAILABLE`); `undefined` sigue. */
  failCreate?: (media: NewMedia) => AppError | undefined;
};

const ROLE_ORDER: Readonly<Record<MediaRole, number>> = { original: 0, processed: 1, rendered: 2 };

/** Como `numeric(10,3)` en Postgres: la duración se guarda con 3 decimales. */
const roundDuration = (durationS: number | null) =>
  durationS === null ? null : Math.round(durationS * 1000) / 1000;

/** La proyección de la carga (F1): sin rol, variante ni medidas. */
function toRecord(media: Media): MediaRecord {
  return {
    id: media.id,
    listingId: media.listingId,
    brokerId: media.brokerId,
    kind: media.kind,
    storagePath: media.storagePath,
    mime: media.mime,
    bytes: media.bytes,
    checksum: media.checksum,
    sortOrder: media.sortOrder,
    isCover: media.isCover,
  };
}

/**
 * `MediaRepository` en memoria, con los mismos únicos que la base: `(listing_id, checksum)` para
 * los originales de un aviso, `storage_path`, `(parent_media_id, variant)` de las variantes y
 * `(listing_id, variant)` de los renders. Como en Postgres, los métodos de la carga ven solo
 * originales. A diferencia de Postgres, no verifica que el aviso de un render exista (allí, la FK
 * o el bloqueo del aviso lo rechazan): en la aplicación el aviso siempre se carga antes.
 */
export function createInMemoryMediaRepository(
  options: InMemoryMediaRepositoryOptions = {},
): InMemoryMediaRepository {
  let next = 0;
  let arrangeCalls = 0;
  const stored = new Map<string, Media>();
  const byId = (a: Media, b: Media) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byOrder = (a: Media, b: Media) => a.sortOrder - b.sortOrder || byId(a, b);
  const originals = () => [...stored.values()].filter((media) => media.role === "original");
  const pathTaken = (storagePath: string, exceptId?: string) =>
    [...stored.values()].some(
      (other) => other.storagePath === storagePath && other.id !== exceptId,
    );
  const conflict = (storagePath: string) =>
    new AppError("MEDIA_CONFLICT", `Ya existe el medio ${storagePath}`, { retriable: true });
  return {
    async listOriginals(listingId) {
      return originals()
        .filter((media) => media.listingId === listingId)
        .sort(byOrder)
        .map(toRecord);
    },
    async listCovers(listingIds) {
      return originals()
        .filter(
          (media) =>
            media.isCover && media.listingId !== null && listingIds.includes(media.listingId),
        )
        .sort(byOrder)
        .map(toRecord);
    },
    async findByStoragePath(storagePath) {
      const found = originals().find((media) => media.storagePath === storagePath);
      return found === undefined ? null : toRecord(found);
    },
    async create(media: NewMedia) {
      const failure = options.failCreate?.(media);
      if (failure !== undefined) throw failure;
      const clash =
        pathTaken(media.storagePath) ||
        (media.listingId !== null &&
          originals().some(
            (other) => other.listingId === media.listingId && other.checksum === media.checksum,
          ));
      if (clash) throw conflict(media.storagePath);
      const created: Media = {
        ...structuredCopy(media),
        id: `media-${++next}`,
        role: "original",
        variant: null,
        parentMediaId: null,
        width: null,
        height: null,
        durationS: null,
      };
      stored.set(created.id, created);
      return toRecord(created);
    },
    async arrange(listingId, items) {
      arrangeCalls += 1;
      // Todo o nada: se valida antes de cambiar algo.
      checkArrangement(items);
      const missing = items.filter(({ id }) => {
        const media = stored.get(id);
        return media?.role !== "original" || media.listingId !== listingId;
      });
      if (missing.length > 0) {
        throw new AppError("MEDIA_NOT_FOUND", "Hay medios que no son originales de ese aviso", {
          details: { listingId, missing: missing.map(({ id }) => id) },
        });
      }
      // Una sola portada por aviso: la nueva desmarca las demás, vengan o no en `items`.
      const cover = items.find((item) => item.isCover);
      if (cover !== undefined) {
        for (const record of originals()) {
          if (record.listingId === listingId && record.isCover && record.id !== cover.id) {
            stored.set(record.id, { ...record, isCover: false });
          }
        }
      }
      for (const { id, sortOrder, isCover } of items) {
        const current = stored.get(id);
        if (current !== undefined) stored.set(id, { ...current, sortOrder, isCover });
      }
    },
    async listByListing(listingId) {
      return [...stored.values()]
        .filter((media) => media.listingId === listingId)
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || byOrder(a, b))
        .map(structuredCopy);
    },
    async get(id) {
      const media = stored.get(id);
      return media === undefined ? null : structuredCopy(media);
    },
    async listVariants(parentMediaIds, variant) {
      return [...stored.values()]
        .filter(
          (media) =>
            media.role === "processed" &&
            media.variant === variant &&
            media.parentMediaId !== null &&
            parentMediaIds.includes(media.parentMediaId),
        )
        .sort(byId)
        .map(structuredCopy);
    },
    async updateMeasurements(id, { width, height, durationS }) {
      const current = stored.get(id);
      if (current === undefined) {
        throw new AppError("MEDIA_NOT_FOUND", `No existe el medio ${id}`, { details: { id } });
      }
      stored.set(id, { ...current, width, height, durationS: roundDuration(durationS) });
    },
    async upsertDerivative(derivative) {
      checkDerivative(derivative);
      if (derivative.role === "processed") {
        const parent = stored.get(derivative.parentMediaId);
        if (
          parent?.role !== "original" ||
          parent.listingId !== derivative.listingId ||
          parent.brokerId !== derivative.brokerId
        ) {
          throw new AppError("MEDIA_NOT_FOUND", "El original del derivado no es de ese aviso", {
            details: { listingId: derivative.listingId, parentMediaId: derivative.parentMediaId },
          });
        }
      }
      const current = [...stored.values()].find((media) =>
        derivative.role === "processed"
          ? media.role === "processed" &&
            media.parentMediaId === derivative.parentMediaId &&
            media.variant === derivative.variant
          : media.role === "rendered" &&
            media.listingId === derivative.listingId &&
            media.variant === derivative.variant,
      );
      if (pathTaken(derivative.storagePath, current?.id)) throw conflict(derivative.storagePath);
      // Campo por campo, como las columnas de la tabla: nada extra que venga en el objeto.
      const media: Media = {
        id: current?.id ?? `media-${++next}`,
        listingId: derivative.listingId,
        brokerId: derivative.brokerId,
        kind: derivative.kind,
        role: derivative.role,
        variant: derivative.variant,
        parentMediaId: derivative.parentMediaId,
        storagePath: derivative.storagePath,
        mime: derivative.mime,
        width: derivative.width,
        height: derivative.height,
        durationS: roundDuration(derivative.durationS),
        bytes: derivative.bytes,
        checksum: derivative.checksum,
        sortOrder: 0,
        isCover: false,
      };
      stored.set(media.id, media);
      const previousPath =
        current !== undefined && current.storagePath !== derivative.storagePath
          ? current.storagePath
          : null;
      return { media: structuredCopy(media), previousPath };
    },
    async deleteDerivative(id) {
      const current = stored.get(id);
      if (current === undefined || current.role === "original") return null;
      stored.delete(id);
      return current.storagePath;
    },
    all: () => originals().sort(byOrder).map(toRecord),
    allMedia: () => [...stored.values()].sort(byOrder).map(structuredCopy),
    arrangeCalls: () => arrangeCalls,
  };
}

export type InMemoryMediaStorage = MediaStorage & {
  /** Objetos guardados, por ruta, con el sha256 que se pidió verificar (si vino). */
  objects: Map<string, { body: Uint8Array; contentType: string; sha256?: string }>;
  /** Rutas de cada `put`/`putStream` exitoso, en orden: para probar que no se resube. */
  uploads: string[];
};

export type InMemoryMediaStorageOptions = {
  /** Error para una subida (por ejemplo, `STORAGE_UNAVAILABLE`); `undefined` para que siga. */
  failUpload?: (path: string) => AppError | undefined;
};

/**
 * `MediaStorage` en memoria. `putStream` lee el iterable completo y, como R2, da
 * `STORAGE_CONTENT_MISMATCH` si el largo no calza con `contentLength` (sin guardar nada). Un
 * error del iterable (el lector del archivo) pasa tal cual. El `sha256` se guarda pero no se
 * verifica, ni su formato: core no calcula hashes, y `memoryFile` usa etiquetas (`sha256-…`) que
 * el adaptador de R2 rechazaría por no ser hexadecimales. En R2 lo verifica R2 (`storage:check`).
 */
export function createInMemoryMediaStorage(
  options: InMemoryMediaStorageOptions = {},
): InMemoryMediaStorage {
  const objects = new Map<string, { body: Uint8Array; contentType: string; sha256?: string }>();
  const uploads: string[] = [];
  const store = (path: string, body: Uint8Array, contentType: string, sha256?: string) => {
    const failure = options.failUpload?.(path);
    if (failure !== undefined) throw failure;
    objects.set(path, {
      body: body.slice(),
      contentType,
      ...(sha256 === undefined ? {} : { sha256 }),
    });
    uploads.push(path);
  };
  return {
    objects,
    uploads,
    async put(path, body, contentType) {
      store(path, body, contentType);
    },
    async putStream(path, body, { contentType, contentLength, sha256 }) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of body) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      if (total !== contentLength) {
        throw new AppError(
          "STORAGE_CONTENT_MISMATCH",
          `El archivo ${path} cambió mientras se subía (se esperaban ${contentLength} bytes)`,
          { details: { path, expected: contentLength, received: total } },
        );
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      store(path, joined, contentType, sha256);
    },
    async get(path) {
      const object = objects.get(path);
      if (object === undefined) {
        throw new AppError("STORAGE_NOT_FOUND", `No existe el objeto ${path}`);
      }
      return object.body.slice();
    },
    async getStream(path) {
      const object = objects.get(path);
      if (object === undefined) {
        throw new AppError("STORAGE_NOT_FOUND", `No existe el objeto ${path}`);
      }
      const body = object.body.slice();
      // En dos trozos, como llega de la red: quien lee no puede suponer un solo trozo. Un objeto
      // vacío no entrega ninguno.
      const middle = Math.ceil(body.byteLength / 2);
      return (async function* () {
        if (middle > 0) yield body.subarray(0, middle);
        if (middle < body.byteLength) yield body.subarray(middle);
      })();
    },
    async head(path): Promise<StoredObjectInfo | null> {
      const object = objects.get(path);
      return object === undefined
        ? null
        : { size: object.body.byteLength, contentType: object.contentType };
    },
    async delete(path) {
      objects.delete(path);
    },
    async signedReadUrl(path, ttlSeconds = 3600) {
      return `memory://${path}?ttl=${ttlSeconds}`;
    },
  };
}

const TYPES: Readonly<Record<string, { kind: MediaKind; mime: string; extension: string }>> = {
  jpg: { kind: "image", mime: "image/jpeg", extension: "jpg" },
  png: { kind: "image", mime: "image/png", extension: "png" },
  heic: { kind: "image", mime: "image/heic", extension: "heic" },
  mp4: { kind: "video", mime: "video/mp4", extension: "mp4" },
  mov: { kind: "video", mime: "video/quicktime", extension: "mov" },
};

export type MemoryFileOptions = {
  /** Lo que entrega `open()` en lugar del contenido (para simular un archivo que cambió). */
  openBytes?: Uint8Array;
  /** Error que lanza `open()` (para simular un archivo que se borró). */
  openError?: AppError;
};

/**
 * Un `MediaFile` sintético. El tipo sale de la extensión (jpg, png, heic, mp4 o mov). Como core no
 * calcula hashes, el sha256 es una etiqueta fija derivada del contenido: dos archivos con el mismo
 * texto tienen el mismo "sha256".
 */
export function memoryFile(
  relPath: string,
  content: string,
  options: MemoryFileOptions = {},
): MediaFile {
  const extension = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  const type = TYPES[extension];
  if (type === undefined) throw new Error(`memoryFile: extensión no soportada en ${relPath}`);
  // Core no tiene `TextEncoder` en sus tipos (sin DOM ni Node): basta con contenido ASCII.
  const bytes = Uint8Array.from(content, (char) => char.charCodeAt(0) & 0xff);
  const sha256 = `sha256-${content}`;
  return {
    relPath,
    ...type,
    bytes: bytes.byteLength,
    sha256,
    async *open() {
      if (options.openError !== undefined) throw options.openError;
      yield options.openBytes ?? bytes;
    },
  };
}

export type InMemoryMediaFileSource = MediaFileSource & {
  /** Carpetas pedidas, en orden. */
  listed: string[];
};

/**
 * `MediaFileSource` en memoria: un mapa `carpeta → listado | error`. Una carpeta que no está en el
 * mapa es `MEDIA_FOLDER_NOT_FOUND`. No valida rutas (`MEDIA_FOLDER_INVALID` es del adaptador, que
 * ya tiene su prueba).
 */
export function createInMemoryMediaFileSource(
  folders: Readonly<
    Record<string, { files?: MediaFile[]; skipped?: SkippedMediaFile[] } | AppError>
  >,
): InMemoryMediaFileSource {
  const listed: string[] = [];
  return {
    listed,
    async list(folder): Promise<MediaFolderListing> {
      listed.push(folder);
      const entry = Object.hasOwn(folders, folder) ? folders[folder] : undefined;
      if (entry === undefined) {
        throw new AppError("MEDIA_FOLDER_NOT_FOUND", `No existe la carpeta de medios "${folder}"`, {
          details: { folder },
        });
      }
      if (entry instanceof AppError) throw entry;
      return { files: [...(entry.files ?? [])], skipped: [...(entry.skipped ?? [])] };
    },
  };
}
