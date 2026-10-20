import { z } from "zod";
import { AppError } from "./errors.js";

// El sujeto de una publicación (ADR-0029, spec F9 §4.2): un aviso o un post. `contents`,
// `content_runs` y `publications` tienen `listing_id` y `post_id` con exactamente uno; core nunca
// ve los dos campos: los repositorios los convierten en un solo `Subject` al leer
// (`subjectFromColumns`) y de vuelta al escribir (`subjectColumns`).

export const SUBJECT_KINDS = ["listing", "post"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const listingSubjectSchema = z.object({ kind: z.literal("listing"), id: z.string() });
export const postSubjectSchema = z.object({ kind: z.literal("post"), id: z.string() });
export const subjectSchema = z.discriminatedUnion("kind", [
  listingSubjectSchema,
  postSubjectSchema,
]);
export type ListingSubject = z.infer<typeof listingSubjectSchema>;
export type PostSubject = z.infer<typeof postSubjectSchema>;
export type Subject = z.infer<typeof subjectSchema>;

export const listingSubject = (id: string): ListingSubject => ({ kind: "listing", id });
export const postSubject = (id: string): PostSubject => ({ kind: "post", id });

/**
 * Lo que aceptan los repositorios donde antes iba el id de un aviso: un `Subject` o, como antes
 * de F9, el id de un aviso. Así los casos de uso de avisos no cambian hasta que T05 a T08 los
 * pasen a sujetos.
 */
export type SubjectRef = Subject | string;

/**
 * Un `SubjectRef` como `Subject`: un texto se trata como el id de un **aviso** (lo de antes de F9,
 * para que los casos de uso de avisos no cambien mientras T05 a T08 los pasan a sujetos). La rama
 * `string` de `SubjectRef` se quita al terminar F9-T08 (criterio de esa tarea en el spec).
 */
export const toSubject = (ref: SubjectRef): Subject =>
  typeof ref === "string" ? listingSubject(ref) : ref;

/** Si dos sujetos son el mismo (mismo tipo y mismo id). */
export const sameSubject = (a: Subject, b: Subject): boolean => a.kind === b.kind && a.id === b.id;

/** Las columnas de un sujeto, como las guarda la base. */
export type SubjectColumns = { listingId: string | null; postId: string | null };

/**
 * Si una fila (un medio, por ejemplo) es de ese sujeto, mirando **las dos** columnas. Nunca se
 * compara solo `listingId`: en un post vale `null`, y `null === null` aceptaría el logo del
 * corredor o lo de otro post.
 */
export const isOfSubject = (columns: SubjectColumns, subject: Subject): boolean =>
  subject.kind === "listing"
    ? columns.listingId === subject.id && columns.postId === null
    : columns.postId === subject.id && columns.listingId === null;

/** Las dos columnas de la base para un sujeto: la suya con el id y la otra nula. */
export const subjectColumns = (subject: Subject): SubjectColumns =>
  subject.kind === "listing"
    ? { listingId: subject.id, postId: null }
    : { listingId: null, postId: subject.id };

/**
 * El sujeto de una fila: `null` si no tiene exactamente uno de `listingId` y `postId` (la base lo
 * impide con un `CHECK`; si pasara, la entidad no valida y el repositorio da su `*_ROW_INVALID`).
 */
export function subjectFromColumns(columns: SubjectColumns): Subject | null {
  if (columns.listingId !== null && columns.postId === null) {
    return listingSubject(columns.listingId);
  }
  if (columns.postId !== null && columns.listingId === null) return postSubject(columns.postId);
  return null;
}

/**
 * Lo que recibe un `create` donde antes iba solo `listingId`: el aviso (como antes) o el post,
 * nunca los dos.
 */
export type SubjectInput =
  | { listingId: string; postId?: undefined }
  | { postId: string; listingId?: undefined };

/** El sujeto de un `SubjectInput`. */
export const subjectOfInput = (input: SubjectInput): Subject =>
  input.postId === undefined ? listingSubject(input.listingId) : postSubject(input.postId);

/**
 * El id del aviso de un sujeto, para los caminos que todavía son solo de avisos (Portal,
 * Marketplace, el candado del aviso, el paso a `active`): un post ahí es
 * `SUBJECT_NOT_LISTING`, no reintentable, en vez de seguir con un id que no es de un aviso.
 */
export function listingIdOf(subject: Subject): string {
  if (subject.kind === "listing") return subject.id;
  throw subjectNotListing(subject);
}

/** `SUBJECT_NOT_LISTING` (no reintentable): un post en un camino que solo es de avisos. */
export const subjectNotListing = (subject: PostSubject): AppError =>
  new AppError("SUBJECT_NOT_LISTING", `El post ${subject.id} no es un aviso`, {
    details: { postId: subject.id },
  });

/**
 * Los campos del sujeto en una entidad (`Content`, `ContentRun`, `Publication`): `subject` manda;
 * `listingId` es un atajo para lo anterior a F9 (`subject.id` si es un aviso, `null` si es un
 * post). Los dos salen de las mismas columnas (`subjectFieldsOf`), así que siempre calzan.
 */
export const subjectFields = {
  subject: subjectSchema,
  /** `subject.id` si el sujeto es un aviso; `null` en un post. Lo nuevo usa `subject`. */
  listingId: z.string().nullable(),
};

/** Los campos de sujeto de una entidad leída de una fila con `listing_id` y `post_id`. */
export const subjectFieldsOf = (
  columns: SubjectColumns,
): { subject: Subject | null; listingId: string | null } => ({
  subject: subjectFromColumns(columns),
  listingId: columns.listingId,
});

/** Los campos de sujeto de una entidad que se arma en memoria (los dobles de prueba). */
export const subjectFieldsFor = (
  subject: Subject,
): { subject: Subject; listingId: string | null } => ({
  subject: { ...subject },
  listingId: subject.kind === "listing" ? subject.id : null,
});
