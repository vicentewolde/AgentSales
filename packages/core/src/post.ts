import { z } from "zod";
import {
  BRIEF_ORIGINS,
  POST_KINDS,
  POST_PLATFORMS,
  POST_SOURCES,
  POST_STATUSES,
  POST_UPLOAD_STATUSES,
  type PostStatus,
} from "./enums.js";
import { AppError } from "./errors.js";

// El post de marca (ADR-0029, spec F9 §4.2): el otro sujeto de una publicación, junto al aviso.

/**
 * Un post (`posts`): un tema con un texto por red e idioma (`contents` con `post_id`) y, a veces,
 * medios. Cuelga de cualquier corredor o marca (`brokerId`): que un aviso solo cuelgue de un
 * `broker` es una regla de core, no de la base. Es la entidad que devuelve `PostRepository`.
 */
export const postSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  topic: z.string(),
  /** Lo que el post debe decir; `null` si no tiene. */
  brief: z.string().nullable(),
  /** Quién escribió el brief (ADR-0030, punto 1): solo el del operador es fuente de hechos. */
  briefOrigin: z.enum(BRIEF_ORIGINS),
  kind: z.enum(POST_KINDS),
  status: z.enum(POST_STATUSES),
  source: z.enum(POST_SOURCES),
  /** La línea de contenido del perfil editorial (`pillars[].key`), si tiene. */
  pillar: z.string().nullable(),
  /** Cuándo se piensa publicar (la idea del plan o lo que fijó el operador). */
  plannedAt: z.date().nullable(),
  /** El plan de ideas que lo propuso (`source = ai`); `null` en los manuales. */
  planRunId: z.string().nullable(),
  /** Quién lo creó o pidió el plan; `null` si se borró el usuario. */
  createdBy: z.string().nullable(),
  /** El porqué de una idea de la IA. */
  rationale: z.string().nullable(),
  /**
   * La marca explícita del operador que permite un enlace en el texto de X (F9-T16, spec F9 §4.4):
   * un post de X con enlace cuesta US$0,20 en vez de US$0,015. No basta con que el enlace esté en
   * el brief: sin esta marca, la revisión lo da por error y el intento no llama a X.
   */
  xLinkAllowed: z.boolean(),
  /**
   * Las redes del post (F9-T20): las que el plan sugirió para una idea, o las que fijó el operador.
   * `null` = todas las de la marca (`postPlatforms`), como un post manual. `post.draft` redacta solo
   * para estas, y solo las que sirven a su `kind` (`kindProblem`).
   */
  platforms: z.array(z.enum(POST_PLATFORMS)).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Post = z.infer<typeof postSchema>;

/**
 * Estados en que un post pide, edita y aprueba sus textos (spec F9 §4.2): `draft` y `ready`. Una
 * `idea` se acepta antes (pasa a `draft`) y un `archived` no se toca. Es el `canPrepareContent` de
 * los avisos.
 */
export const canDraftPost = (status: PostStatus): boolean =>
  status === "draft" || status === "ready";

/** `POST_NOT_READY` (409): el post es una idea sin aceptar o está archivado. */
export const postNotReady = (post: Pick<Post, "id" | "status">) =>
  new AppError(
    "POST_NOT_READY",
    "El post tiene que estar en borrador o listo: acepta la idea o crea un post nuevo",
    { details: { postId: post.id, status: post.status } },
  );

/**
 * Una subida pendiente de un post (`post_uploads`, spec F9 §4.5, ADR-0025): la URL prefirmada se
 * pidió y el archivo puede no haber llegado. La limpieza periódica borra de R2 lo abandonado.
 */
export const postUploadSchema = z.object({
  id: z.string(),
  postId: z.string(),
  /** La clave de R2, bajo `posts/{postId}/…`. */
  objectPath: z.string(),
  expectedBytes: z.number().int().nonnegative(),
  status: z.enum(POST_UPLOAD_STATUSES),
  expiresAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PostUpload = z.infer<typeof postUploadSchema>;
