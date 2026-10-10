import { z } from "zod";

/** Un monto entero en pesos chilenos, sin decimales (lo que pide el formulario). */
const clp = z.number().int().nonnegative();

/**
 * Lo que dejó el intento de Marketplace que llegó a `awaiting_manual_confirm` (spec F5 §4.3 y
 * §4.9, ADR-0017): lo arma core en esa transición y, después, solo `updateProgress` lo cambia
 * (`windowClosedAt`). Marketplace no retoma nada desde aquí: no hay nada creado en Facebook que
 * reconocer. Es jsonb: las fechas van como texto ISO.
 */
export const marketplaceProgressSchema = z.object({
  /** El número de intento (`publications.attempts`) que dejó el formulario listo. */
  attempt: z.number().int().positive(),
  /** Si el formulario listo es una simulación (`dry-run`: no se abrió Facebook). */
  simulated: z.boolean(),
  /** Cuándo quedó listo el formulario. */
  formReadyAt: z.iso.datetime(),
  /** Cuántas fotos se subieron al formulario. */
  photos: z.number().int().nonnegative(),
  /** El precio que se escribió en el formulario, en pesos. */
  priceClp: clp,
  /** Si el aviso estaba en UF: el valor de la UF usado, como texto decimal (`41130.94`). */
  ufValue: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
  /** El día de ese valor de la UF (`AAAA-MM-DD`, Santiago). */
  ufDate: z.iso.date().optional(),
  /** Cuándo se cerró la ventana sin que el sistema viera el aviso publicado. */
  windowClosedAt: z.iso.datetime().optional(),
});
export type MarketplaceProgress = z.infer<typeof marketplaceProgressSchema>;
