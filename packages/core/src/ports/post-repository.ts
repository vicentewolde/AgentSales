import type { AccessScope } from "../access.js";
import type { BriefOrigin, PostKind, PostSource, PostStatus } from "../enums.js";
import type { Post, PostUpload } from "../post.js";

/** Un post nuevo (spec F9 §4.2): manual por defecto, en `draft` y con el brief del operador. */
export type NewPost = {
  brokerId: string;
  topic: string;
  kind: PostKind;
  brief?: string | null;
  /** Por defecto `operator`; una idea de la IA nace con `ai` (ADR-0030). */
  briefOrigin?: BriefOrigin;
  /** Por defecto `draft`; una idea de la IA nace en `idea`. */
  status?: PostStatus;
  /** Por defecto `manual`. */
  source?: PostSource;
  pillar?: string | null;
  plannedAt?: Date | null;
  planRunId?: string | null;
  createdBy?: string | null;
  rationale?: string | null;
  /** Por defecto `false` (F9-T16). */
  xLinkAllowed?: boolean;
};

/** Lo que se puede cambiar de un post; `undefined` = no tocar, `null` borra. */
export type PostChanges = {
  topic?: string;
  brief?: string | null;
  briefOrigin?: BriefOrigin;
  kind?: PostKind;
  status?: PostStatus;
  pillar?: string | null;
  plannedAt?: Date | null;
  rationale?: string | null;
  xLinkAllowed?: boolean;
};

/**
 * Los posts que pide la lista (`GET /api/posts`, spec F9 §4.10), siempre dentro del alcance
 * (ADR-0022): un corredor ve solo los de su marca. Con `from` y `to`, los de `planned_at` en
 * `[from, to)` (los sin fecha quedan fuera).
 */
export type PostFilters = {
  brokerId?: string;
  status?: PostStatus | readonly PostStatus[];
  from?: Date;
  to?: Date;
};

/**
 * Los cambios que `update` aplica: solo los campos de `PostChanges` y sin los `undefined`. Una
 * clave ajena que llegue por un cast no pisa otra columna. La usan todas las implementaciones.
 */
export function pickPostChanges(changes: PostChanges): PostChanges {
  const picked: PostChanges = {};
  if (changes.topic !== undefined) picked.topic = changes.topic;
  if (changes.brief !== undefined) picked.brief = changes.brief;
  if (changes.briefOrigin !== undefined) picked.briefOrigin = changes.briefOrigin;
  if (changes.kind !== undefined) picked.kind = changes.kind;
  if (changes.status !== undefined) picked.status = changes.status;
  if (changes.pillar !== undefined) picked.pillar = changes.pillar;
  if (changes.plannedAt !== undefined) {
    picked.plannedAt = changes.plannedAt === null ? null : new Date(changes.plannedAt);
  }
  if (changes.rationale !== undefined) picked.rationale = changes.rationale;
  if (changes.xLinkAllowed !== undefined) picked.xLinkAllowed = changes.xLinkAllowed;
  return picked;
}

/**
 * Posts (`posts`, ADR-0029). Lectura y escritura básicas: las reglas (qué estado sigue a cuál,
 * quién puede) son de los casos de uso (F9-T10 y T20). Errores (`AppError`):
 * - `update` o `archive` de un post que no existe → `POST_NOT_FOUND`;
 * - un corredor, un plan o un usuario que no existen al crear → `POST_REFERENCE_INVALID`;
 * - una fila que no calza con la entidad → `POST_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface PostRepository {
  create(post: NewPost): Promise<Post>;
  get(id: string): Promise<Post | null>;
  /**
   * Los del alcance que calzan con los filtros: por `planned_at` (los sin fecha al final), después
   * por `created_at` y por id.
   */
  list(filters: PostFilters, scope: AccessScope): Promise<Post[]>;
  /** Cambia los campos dados (y `updated_at`); devuelve el post actualizado. */
  update(id: string, changes: PostChanges): Promise<Post>;
  /** Lo pasa a `archived` (descartado o terminado); si ya lo estaba, lo devuelve igual. */
  archive(id: string): Promise<Post>;
}

/** Una subida nueva de un post (ADR-0025): nace en `pending`. */
export type NewPostUpload = {
  /**
   * El id, si ya va en la clave (F9-T17: un archivo de más de 100 MB sin sha256 se guarda en
   * `posts/{postId}/original/{uploadId}.{ext}`). Sin él, lo pone el repositorio.
   */
  id?: string;
  postId: string;
  objectPath: string;
  expectedBytes: number;
  expiresAt: Date;
};

/**
 * Las subidas pendientes de un post (`post_uploads`, spec F9 §4.5). Los cambios de estado son
 * condicionales y devuelven si cambiaron: solo una `pending` pasa a `completed` o `abandoned`.
 * Errores (`AppError`):
 * - `create` con una `objectPath` que ya existe → `POST_UPLOAD_CONFLICT`;
 * - `create` de un post que no existe → `POST_UPLOAD_REFERENCE_INVALID`;
 * - una fila que no calza con la entidad → `POST_UPLOAD_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface PostUploadRepository {
  create(upload: NewPostUpload): Promise<PostUpload>;
  get(id: string): Promise<PostUpload | null>;
  /** Las de un post, por fecha de creación y después id. */
  listByPost(postId: string): Promise<PostUpload[]>;
  /** Las `pending` vencidas (`expires_at` anterior a `now`), las más antiguas primero. */
  listExpired(now: Date): Promise<PostUpload[]>;
  /**
   * Las `uploaded` (F9-T17) que quedaron así desde antes de `before` (`updated_at`: la hora en que
   * llegaron), las más antiguas primero: el worker no pudo revisarlas (agotó sus reintentos).
   */
  listStaleUploaded(before: Date): Promise<PostUpload[]>;
  /**
   * `pending` o `uploaded` → `completed`; `false` si ya no estaba en uno de esos estados o no
   * existe.
   */
  markCompleted(id: string): Promise<boolean>;
  /**
   * `pending` → `uploaded` (F9-T17): el archivo grande sin sha256 llegó a R2 con su tamaño y espera
   * que el worker lo hashee; `false` si ya no estaba pendiente o no existe.
   */
  markUploaded(id: string): Promise<boolean>;
  /**
   * `pending` o `uploaded` → `abandoned`; `false` si ya no estaba en uno de esos estados o no
   * existe. Una `uploaded` solo se abandona si su archivo desapareció de R2 antes de que el worker
   * lo revisara (F9-T17).
   */
  markAbandoned(id: string): Promise<boolean>;
  /**
   * Vuelve a `pending` con un vencimiento nuevo, venga del estado que venga (F9-T10): el mismo
   * archivo pedido otra vez (una URL vencida, o una subida que la limpieza abandonó) reutiliza su
   * fila y su clave. Devuelve la subida actualizada; `null` si no existe.
   */
  reopen(id: string, expiresAt: Date): Promise<PostUpload | null>;
}
