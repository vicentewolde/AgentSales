import type {
  MediaKind,
  MediaVariant,
  ProcessedMediaVariant,
  RenderedMediaVariant,
} from "../enums.js";
import {
  PROCESSED_MEDIA_VARIANTS,
  RENDERED_MEDIA_VARIANTS,
  VIDEO_MEDIA_VARIANTS,
} from "../enums.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";
import { type Subject, type SubjectInput, sameSubject } from "../subject.js";

/** Un medio original guardado (`media` con `role = original`): lo que la ingesta necesita. */
export type MediaRecord = {
  id: string;
  /** `null` para los medios de un post y los del corredor (logo). */
  listingId: string | null;
  /** El post del medio (F9, ADR-0029); `null` en los de un aviso y en el logo. */
  postId: string | null;
  brokerId: string;
  kind: MediaKind;
  storagePath: string;
  mime: string;
  bytes: number;
  /** sha256 del contenido, en hexadecimal. */
  checksum: string;
  sortOrder: number;
  isCover: boolean;
};

/**
 * Medio original nuevo (la carga, o desde F9 la subida de un post); los derivados entran por
 * `upsertDerivative`. `postId` por defecto `null`; a lo más uno de `listingId` y `postId`.
 */
export type NewMedia = Omit<MediaRecord, "id" | "postId"> & { postId?: string | null };

/**
 * Valida un medio nuevo antes de tocar nada; la usan todas las implementaciones. Un medio de un
 * aviso y de un post a la vez es un bug de quien llama: `MEDIA_SUBJECT_INVALID`, no reintentable.
 */
export function checkNewMedia(media: NewMedia): void {
  if (media.listingId !== null && (media.postId ?? null) !== null) {
    throw new AppError(
      "MEDIA_SUBJECT_INVALID",
      "Un medio es de un aviso o de un post, no de los dos",
    );
  }
}

/** Medidas de un medio, ya rotadas; `null` si no aplica (un video sin alto conocido, una foto). */
export type MediaMeasurements = {
  width: number | null;
  height: number | null;
  durationS: number | null;
};

type DerivativeData = MediaMeasurements &
  SubjectInput & {
    brokerId: string;
    kind: MediaKind;
    storagePath: string;
    mime: string;
    bytes: number;
    /** sha256 del contenido, en hexadecimal: lo calcula quien produjo el archivo. */
    checksum: string;
  };

/**
 * Un derivado de un aviso (spec F2 §4.2): una variante de un original (`processed`, con su
 * `parentMediaId`) o un render de plantilla (`rendered`, sin padre). Desde F9, también la variante
 * de un original de un post (`postId`); un post no tiene renders.
 */
export type NewDerivative =
  | (DerivativeData & {
      role: "processed";
      variant: ProcessedMediaVariant;
      parentMediaId: string;
    })
  | (DerivativeData & { role: "rendered"; variant: RenderedMediaVariant; parentMediaId: null });

/** Resultado de `upsertDerivative`: la fila vigente y la clave anterior si cambió (para borrarla). */
export type DerivativeResult = { media: Media; previousPath: string | null };

/**
 * Valida un derivado antes de tocar nada; la usan todas las implementaciones. Una variante que no
 * es de su rol (un `cover` como `processed`), un padre que no corresponde al rol, un tipo que no
 * calza (el reel y el video para X son video; lo demás, imagen) o un render de un post es un bug
 * de quien llama: `MEDIA_DERIVATIVE_INVALID`, no reintentable.
 */
export function checkDerivative(derivative: NewDerivative): void {
  const variants: readonly MediaVariant[] =
    derivative.role === "processed" ? PROCESSED_MEDIA_VARIANTS : RENDERED_MEDIA_VARIANTS;
  const parentOk =
    derivative.role === "processed"
      ? typeof derivative.parentMediaId === "string" && derivative.parentMediaId.length > 0
      : derivative.parentMediaId === null;
  // El reel y el video para X son video; las demás variantes y los renders son imágenes.
  const isVideo = (VIDEO_MEDIA_VARIANTS as readonly MediaVariant[]).includes(derivative.variant);
  const kindOk = derivative.kind === (isVideo ? "video" : "image");
  // Un post usa sus propios medios: sin portada ni ficha de plantilla (spec F9 §3).
  const subjectOk = derivative.role === "processed" || derivative.postId === undefined;
  if (!variants.includes(derivative.variant) || !parentOk || !kindOk || !subjectOk) {
    throw new AppError(
      "MEDIA_DERIVATIVE_INVALID",
      `La variante ${derivative.variant} no corresponde a un medio ${derivative.role}`,
      { details: { role: derivative.role, variant: derivative.variant } },
    );
  }
}

/** Posición y portada de un medio de un aviso. */
export type MediaArrangement = { id: string; sortOrder: number; isCover: boolean };

/** `media.sort_order` es `integer` (int4). */
const MAX_SORT_ORDER = 2 ** 31 - 1;

/**
 * Valida un `arrange` antes de tocar nada; la usan todas las implementaciones. Ids repetidos, más
 * de una portada o un `sortOrder` que no es un entero entre 0 y el máximo de int4 son un bug de
 * quien llama: `MEDIA_ARRANGE_INVALID`, no reintentable.
 */
export function checkArrangement(items: readonly MediaArrangement[]): void {
  const badOrder = items.find(
    ({ sortOrder }) => !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > MAX_SORT_ORDER,
  );
  if (badOrder !== undefined) {
    throw new AppError("MEDIA_ARRANGE_INVALID", `Orden inválido: ${badOrder.sortOrder}`);
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new AppError("MEDIA_ARRANGE_INVALID", "Un medio aparece dos veces en el orden");
  }
  if (items.filter((item) => item.isCover).length > 1) {
    throw new AppError("MEDIA_ARRANGE_INVALID", "Hay más de una portada en el orden");
  }
}

/**
 * Medios (`media`). Los métodos de la carga (F1: `listOriginals`, `listCovers`,
 * `findByStoragePath`, `create` y `arrange`) ven solo originales; los de F2 (`listBySubject`,
 * `updateMeasurements` y los derivados) ven también variantes y renders. Únicos por
 * `(listing_id, checksum)` y, desde F9, `(post_id, checksum)` de los originales, por
 * `storage_path`, por `(parent_media_id, variant)` de las variantes y por `(listing_id, variant)`
 * de los renders (spec F1 §4.5, F2 §4.3 y F9 §4.11). Donde antes iba el id del aviso, desde F9 va
 * un `Subject` (aviso o post; desde F9-T08, nunca el id suelto de un aviso).
 * Errores (`AppError`):
 * - `create` que choca con uno de esos únicos → `MEDIA_CONFLICT`, **reintentable**: dos intentos
 *   del job pueden solaparse, y el reintento lo encuentra con `listOriginals` o `findByStoragePath`;
 * - `arrange` con un id que no es original de ese aviso o post → `MEDIA_NOT_FOUND`, y con ids
 *   repetidos, más de una portada o un `sortOrder` inválido → `MEDIA_ARRANGE_INVALID`; sin cambiar
 *   nada. En Postgres, dos `arrange` del mismo aviso (o post) se serializan (bloqueo de su fila);
 * - `upsertDerivative` con un derivado inconsistente → `MEDIA_DERIVATIVE_INVALID`; con un padre que
 *   no es original del aviso (o post), o de otro corredor → `MEDIA_NOT_FOUND`; si dos intentos solapados
 *   chocan con un único, o uno borró el vigente mientras otro lo reemplazaba → `MEDIA_CONFLICT`,
 *   reintentable;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface MediaRepository {
  /** Originales de un aviso o post, por `sortOrder` y luego por id. */
  listOriginals(subject: Subject): Promise<MediaRecord[]>;
  /** Portadas (originales con `isCover`) de esos avisos, para la lista de la API. */
  listCovers(listingIds: readonly string[]): Promise<MediaRecord[]>;
  /** Para el logo, que no tiene aviso: su clave en R2 lleva el sha256. */
  findByStoragePath(storagePath: string): Promise<MediaRecord | null>;
  create(media: NewMedia): Promise<MediaRecord>;
  /**
   * Fija orden y portada de varios originales de un aviso o post, todo o nada. Hay **una sola
   * portada** por aviso o post: si un item trae `isCover`, los demás originales dejan de serlo,
   * vengan o no en `items`. Solo considera originales (`role = original`).
   */
  arrange(subject: Subject, items: readonly MediaArrangement[]): Promise<void>;
  /**
   * Todos los medios del aviso o post (originales, variantes y renders), por rol (`original`,
   * `processed`, `rendered`), `sortOrder` e id. No incluye el logo del corredor, que no tiene
   * sujeto. Desde F9-T08 absorbe el `listByListing` de antes (un aviso es `listingSubject(id)`).
   */
  listBySubject(subject: Subject): Promise<Media[]>;
  /** Un medio por id, de cualquier rol (por ejemplo, el logo del corredor); `null` si no existe. */
  get(id: string): Promise<Media | null>;
  /**
   * Las variantes vigentes `variant` de esos originales, en una sola consulta (por ejemplo, el
   * `thumb` de las portadas de la lista de avisos). Sin ids devuelve `[]` sin consultar.
   */
  listVariants(parentMediaIds: readonly string[], variant: ProcessedMediaVariant): Promise<Media[]>;
  /** Guarda las medidas de un medio. Un id inexistente es `MEDIA_NOT_FOUND`. */
  updateMeasurements(id: string, measurements: MediaMeasurements): Promise<void>;
  /**
   * Crea el derivado o **reemplaza en su lugar** el vigente (la misma fila, con la clave, el
   * contenido y las medidas nuevas): uno por original y variante, y uno por aviso y variante de
   * render. `previousPath` es la clave anterior si cambió, para que quien llama borre ese objeto de
   * R2; `null` si el derivado es nuevo o la clave es la misma.
   */
  upsertDerivative(derivative: NewDerivative): Promise<DerivativeResult>;
  /**
   * Borra un derivado (por ejemplo, el reel de un video que dejó de ser el primero) y devuelve su
   * clave, para borrar el objeto de R2. `null` si no existe o si es un original (un original nunca
   * se borra aquí): es idempotente.
   */
  deleteDerivative(id: string): Promise<string | null>;
}

/**
 * Los medios que entrega un candado (`ListingLock` o `PostLock`): `arrange` bloquea la fila de su
 * sujeto, así que dentro del candado solo se usa con el sujeto de ese candado. Con otro sería un
 * segundo bloqueo dentro del primero (el anidado que las reglas prohíben, y un deadlock posible):
 * `LOCK_SUBJECT_MISMATCH`, no reintentable, sin tocar nada. La usan todas las implementaciones de
 * los candados.
 */
export function lockedMedia(media: MediaRepository, subject: Subject): MediaRepository {
  return {
    ...media,
    async arrange(target, items) {
      if (!sameSubject(target, subject)) {
        throw new AppError(
          "LOCK_SUBJECT_MISMATCH",
          "Dentro de un candado solo se ordenan los medios de su propio aviso o post",
          { details: { lock: subject, target } },
        );
      }
      return media.arrange(target, items);
    },
  };
}
