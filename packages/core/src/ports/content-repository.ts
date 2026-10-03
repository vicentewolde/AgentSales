import type { Content, ContentRun, ContentRunError, ContentRunReport } from "../content.js";
import type { ContentRunStage, ContentStatus, LlmProvider, Platform } from "../enums.js";
import { AppError } from "../errors.js";

export type NewContentRun = {
  listingId: string;
  /** Si la corrida genera textos (`false`: solo medios y renders). */
  texts: boolean;
};

/** Un texto nuevo de una corrida: nace en `draft` y hereda el aviso de la corrida. */
export type NewContent = {
  platform: Platform;
  title: string | null;
  body: string;
  hashtags: string[];
  llmProvider: LlmProvider;
  llmModel: string;
  promptVersion: string;
  rawOutput: unknown;
};

/**
 * Corridas de contenido (`content_runs`, ADR-0012; spec F2 §4.3 y §4.4). Los cambios de estado son
 * **condicionales** y devuelven si cambiaron, como los de `ImportRunRepository`: un reintento sobre
 * una corrida terminal no hace nada. Errores (`AppError`):
 * - `create` con una corrida activa (`queued` o `running`) del mismo aviso → `CONTENT_RUN_CONFLICT`,
 *   **reintentable**: otra petición ganó la carrera, y quien llama busca la activa con `findActive`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 * Los ids son uuid: la API los valida antes de llegar aquí.
 */
export interface ContentRunRepository {
  /** Nace en `queued`, sin etapa, reporte ni fechas. */
  create(run: NewContentRun): Promise<ContentRun>;
  get(id: string): Promise<ContentRun | null>;
  /** La corrida `queued` o `running` del aviso, si hay (a lo más una). */
  findActive(listingId: string): Promise<ContentRun | null>;
  /** La corrida más reciente del aviso (`created_at` y después `id`), en cualquier estado. */
  latest(listingId: string): Promise<ContentRun | null>;
  /** Las corridas en `queued`, las más antiguas primero: el worker las reencola al arrancar. */
  listQueued(): Promise<ContentRun[]>;
  /**
   * `queued` o `running` → `running` (un reintento del job la vuelve a tomar). Fija `started_at`
   * solo la primera vez. `false` si la corrida ya terminó o no existe.
   */
  markRunning(id: string): Promise<boolean>;
  /** Fija la etapa en curso, solo mientras la corrida está en `running`. */
  setStage(id: string, stage: ContentRunStage): Promise<boolean>;
  /**
   * `running` → `succeeded` con `report` y `finished_at`, y guarda `contents` (en `draft`, del aviso
   * de la corrida) **en la misma transacción**: o queda todo, o nada. `false`, sin escribir nada,
   * si la corrida no está en `running` o si alguno de sus canales ya tiene fila (un intento
   * solapado ya guardó): ese intento termina como `skipped`. Una corrida con `texts = false` pasa
   * `contents` vacío. Un canal repetido en `contents` es un bug de quien llama:
   * `CONTENT_PLATFORM_DUPLICATED`, no reintentable, sin escribir nada (`checkNewContents`).
   */
  markSucceeded(
    id: string,
    result: { report: ContentRunReport; contents: readonly NewContent[] },
  ): Promise<boolean>;
  /**
   * `queued` o `running` → `failed`, con `error`, el reporte hasta donde llegó (si lo hay) y
   * `finished_at`. `false` si ya terminó o no existe: el primer estado terminal gana.
   */
  markFailed(id: string, error: ContentRunError, report?: ContentRunReport): Promise<boolean>;
  /**
   * Cierra las corridas abandonadas: las que siguen en `running` con `started_at` anterior a
   * `startedBefore` pasan a `failed` con `error`. No toca las `queued`: el worker las reencola
   * (spec F2 §4.4). Devuelve los ids cerrados.
   */
  failAbandoned(startedBefore: Date, error: ContentRunError): Promise<string[]>;
}

/** Lo que el operador puede cambiar de un texto (F2-T12), y su nuevo estado. */
export type ContentChanges = {
  title?: string | null;
  body?: string;
  hashtags?: string[];
  status?: ContentStatus;
};

/**
 * Valida los textos de `markSucceeded` antes de tocar nada; la usan todas las implementaciones.
 * Un canal repetido es `CONTENT_PLATFORM_DUPLICATED`, no reintentable.
 */
export function checkNewContents(contents: readonly NewContent[]): void {
  const platforms = contents.map((content) => content.platform);
  if (new Set(platforms).size !== platforms.length) {
    throw new AppError("CONTENT_PLATFORM_DUPLICATED", "Un canal aparece dos veces en los textos");
  }
}

/**
 * Los cambios que `update` aplica: solo los campos de `ContentChanges` y sin los `undefined`
 * (`undefined` = no tocar; `null` borra el título). Una clave ajena que llegue por un cast no
 * pisa otra columna. La usan todas las implementaciones.
 */
export function pickContentChanges(changes: ContentChanges): ContentChanges {
  const picked: ContentChanges = {};
  if (changes.title !== undefined) picked.title = changes.title;
  if (changes.body !== undefined) picked.body = changes.body;
  if (changes.hashtags !== undefined) picked.hashtags = [...changes.hashtags];
  if (changes.status !== undefined) picked.status = changes.status;
  return picked;
}

/**
 * Textos generados (`contents`). El **vigente** de un aviso en un canal es su fila más reciente
 * (`created_at` y después `id`, ADR-0012). Las filas las crea `ContentRunRepository.markSucceeded`.
 * `update` no verifica que el texto sea el vigente: quien llama lo compara con `listCurrent`
 * (`editContent`, F2-T12). Un `update` de un id que no existe es `CONTENT_NOT_FOUND`.
 */
export interface ContentRepository {
  /** El texto vigente de cada canal del aviso, uno por plataforma, en el orden de `PLATFORMS`. */
  listCurrent(listingId: string): Promise<Content[]>;
  get(id: string): Promise<Content | null>;
  /** Cambia los campos dados (y `updated_at`); devuelve la fila actualizada. */
  update(id: string, changes: ContentChanges): Promise<Content>;
}
