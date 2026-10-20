import { z } from "zod";
import {
  BRIEF_ORIGINS,
  POST_KINDS,
  POST_SOURCES,
  POST_STATUSES,
  POST_UPLOAD_STATUSES,
} from "./enums.js";

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
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Post = z.infer<typeof postSchema>;

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
