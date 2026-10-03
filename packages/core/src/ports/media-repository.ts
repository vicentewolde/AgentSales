import type {
  MediaKind,
  MediaVariant,
  ProcessedMediaVariant,
  RenderedMediaVariant,
} from "../enums.js";
import { PROCESSED_MEDIA_VARIANTS, RENDERED_MEDIA_VARIANTS } from "../enums.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";

/** Un medio original guardado (`media` con `role = original`): lo que la ingesta necesita. */
export type MediaRecord = {
  id: string;
  /** `null` para los medios del corredor (logo). */
  listingId: string | null;
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

/** Medio original nuevo (la carga); los derivados entran por `upsertDerivative`. */
export type NewMedia = Omit<MediaRecord, "id">;

/** Medidas de un medio, ya rotadas; `null` si no aplica (un video sin alto conocido, una foto). */
export type MediaMeasurements = {
  width: number | null;
  height: number | null;
  durationS: number | null;
};

type DerivativeData = MediaMeasurements & {
  listingId: string;
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
 * `parentMediaId`) o un render de plantilla (`rendered`, sin padre).
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
 * es de su rol (un `cover` como `processed`), un padre que no corresponde al rol o un tipo que no
 * calza (el reel es video; lo demás, imagen) es un bug de quien llama: `MEDIA_DERIVATIVE_INVALID`,
 * no reintentable.
 */
export function checkDerivative(derivative: NewDerivative): void {
  const variants: readonly MediaVariant[] =
    derivative.role === "processed" ? PROCESSED_MEDIA_VARIANTS : RENDERED_MEDIA_VARIANTS;
  const parentOk =
    derivative.role === "processed"
      ? typeof derivative.parentMediaId === "string" && derivative.parentMediaId.length > 0
      : derivative.parentMediaId === null;
  // El reel es el único video; las demás variantes y los renders son imágenes.
  const kindOk = derivative.kind === (derivative.variant === "ig_reel" ? "video" : "image");
  if (!variants.includes(derivative.variant) || !parentOk || !kindOk) {
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
 * `findByStoragePath`, `create` y `arrange`) ven solo originales; los de F2 (`listByListing`,
 * `updateMeasurements` y los derivados) ven también variantes y renders. Únicos por
 * `(listing_id, checksum)` de los originales, por `storage_path`, por `(parent_media_id, variant)`
 * de las variantes y por `(listing_id, variant)` de los renders (spec F1 §4.5 y F2 §4.3).
 * Errores (`AppError`):
 * - `create` que choca con uno de esos únicos → `MEDIA_CONFLICT`, **reintentable**: dos intentos
 *   del job pueden solaparse, y el reintento lo encuentra con `listOriginals` o `findByStoragePath`;
 * - `arrange` con un id que no es original de ese aviso → `MEDIA_NOT_FOUND`, y con ids repetidos,
 *   más de una portada o un `sortOrder` inválido → `MEDIA_ARRANGE_INVALID`; sin cambiar nada. En
 *   Postgres, dos `arrange` del mismo aviso se serializan (bloqueo del aviso);
 * - `upsertDerivative` con un derivado inconsistente → `MEDIA_DERIVATIVE_INVALID`; con un padre que
 *   no es original del aviso, o de otro corredor → `MEDIA_NOT_FOUND`; si dos intentos solapados
 *   chocan con un único, o uno borró el vigente mientras otro lo reemplazaba → `MEDIA_CONFLICT`,
 *   reintentable;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface MediaRepository {
  /** Originales de un aviso, por `sortOrder` y luego por id. */
  listOriginals(listingId: string): Promise<MediaRecord[]>;
  /** Portadas (originales con `isCover`) de esos avisos, para la lista de la API. */
  listCovers(listingIds: readonly string[]): Promise<MediaRecord[]>;
  /** Para el logo, que no tiene aviso: su clave en R2 lleva el sha256. */
  findByStoragePath(storagePath: string): Promise<MediaRecord | null>;
  create(media: NewMedia): Promise<MediaRecord>;
  /**
   * Fija orden y portada de varios originales de un aviso, todo o nada. Hay **una sola portada**
   * por aviso: si un item trae `isCover`, los demás originales del aviso dejan de serlo, vengan o
   * no en `items`. Solo considera originales (`role = original`).
   */
  arrange(listingId: string, items: readonly MediaArrangement[]): Promise<void>;
  /**
   * Todos los medios del aviso (originales, variantes y renders), por rol (`original`, `processed`,
   * `rendered`), `sortOrder` e id. No incluye el logo del corredor, que no tiene aviso.
   */
  listByListing(listingId: string): Promise<Media[]>;
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
