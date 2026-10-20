import { z } from "zod";
import { MEDIA_KINDS, MEDIA_ROLES, MEDIA_VARIANTS } from "./enums.js";

/**
 * Medio (`media`): un original subido en la carga, una variante (`processed`) o un render
 * (`rendered`). Es la entidad que devuelve `MediaRepository.listByListing` (ADR-0011, el esquema
 * que F1 dejó pendiente). La vista HTTP (`mediaItemSchema` de `contracts`) no expone `storagePath`
 * ni `checksum`. `MediaRecord` sigue siendo la proyección de la carga (solo originales).
 */
export const mediaSchema = z
  .object({
    id: z.string(),
    /** `null` para los medios de un post y los del corredor (logo). */
    listingId: z.string().nullable(),
    /**
     * El post del medio (F9, ADR-0029); `null` en los de un aviso y en el logo. A lo más uno de
     * `listingId` y `postId` (el `CHECK` de la base; la entidad lo revisa al leer).
     */
    postId: z.string().nullable(),
    brokerId: z.string(),
    kind: z.enum(MEDIA_KINDS),
    role: z.enum(MEDIA_ROLES),
    /** `null` en un original. */
    variant: z.enum(MEDIA_VARIANTS).nullable(),
    /** El original de una variante; `null` en originales y renders. */
    parentMediaId: z.string().nullable(),
    storagePath: z.string(),
    mime: z.string(),
    /** Medidas ya rotadas; `null` hasta que la etapa `media` las mide (spec F2 §4.2). */
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    /** Solo videos. */
    durationS: z.number().nullable(),
    bytes: z.number().int().nonnegative(),
    /** sha256 del contenido, en hexadecimal. */
    checksum: z.string(),
    sortOrder: z.number().int(),
    isCover: z.boolean(),
  })
  .refine((media) => media.listingId === null || media.postId === null, {
    path: ["postId"],
    message: "Un medio es de un aviso o de un post, no de los dos",
  });
export type Media = z.infer<typeof mediaSchema>;
