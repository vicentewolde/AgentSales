import { z } from "zod";

/** Solo dígitos, como los exige Mercado Libre en `country_code2` y `phone2` (nota §4.2). */
const digits = z.string().regex(/^\d+$/);

/**
 * El contacto del corredor tal como se envió al crear el ítem (`seller_contact`, spec F4 §4.5).
 * Mercado Libre lo exige completo en cada escritura; las operaciones (pausar, reactivar, cerrar)
 * reutilizan este y no el actual del corredor, así un cambio de WhatsApp no impide cerrar.
 */
export const portalSellerContactSchema = z.object({
  contact: z.string().nullable(),
  email: z.string().nullable(),
  /** Código de país del WhatsApp (`56`). */
  countryCode2: digits,
  /** El resto del número de WhatsApp (`912345678`). */
  phone2: digits,
});
export type PortalSellerContact = z.infer<typeof portalSellerContactSchema>;

/**
 * Lo que el publisher de Portal ya hizo en Mercado Libre (`publications.progress`, spec F4 §4.8):
 * se guarda antes de cada paso que crea algo, para que un reintento retome sin subir las fotos de
 * nuevo ni crear dos ítems (gastaría dos cupos). Es jsonb: las fechas van como texto ISO.
 */
export const portalProgressSchema = z.object({
  /** Fotos ya subidas a `/pictures/items/upload`, en el orden de la publicación. */
  pictureIds: z.array(z.string().min(1)),
  /** El `seller_contact` enviado al crear el ítem. */
  sellerContact: portalSellerContactSchema.optional(),
  /** Cuándo se pidió `POST /items`: con esto y sin `itemId`, nunca se repite el pedido solo. */
  createRequestedAt: z.iso.datetime().optional(),
  /** Id del ítem en Mercado Libre, apenas responde la creación. */
  itemId: z.string().min(1).optional(),
  /** Si la descripción ya se cargó (cuando no va en el `POST`). */
  descriptionDone: z.boolean().optional(),
  /** Si la dirección ya se ocultó (`address_line_by_reference`, D7). */
  addressHidden: z.boolean().optional(),
});
export type PortalProgress = z.infer<typeof portalProgressSchema>;
