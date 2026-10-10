import { z } from "zod";
import { formatNumber, formatPrice } from "../price.js";

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

/**
 * Lo que el operador ve de un formulario de Marketplace (spec F5 §4.10, `manual` en la vista de la
 * publicación), derivado del progreso sin exponerlo crudo. `windowOpen`: la ventana de Chromium
 * debería seguir abierta (espera el clic, no es simulación y nadie anotó que se cerró).
 */
export type MarketplaceManualState = {
  formReadyAt: Date;
  simulated: boolean;
  windowOpen: boolean;
  windowClosedAt: Date | null;
  photos: number;
  priceClp: number;
  ufValue: string | null;
  ufDate: string | null;
};

/**
 * El formulario del **intento actual** de una publicación de Marketplace, o `null` (otra
 * plataforma, sin progreso, un progreso que no calza, o uno de un intento anterior: al reintentar,
 * el formulario viejo ya no vale). Lo usan la vista de la API y, por ella, la CLI y el panel.
 */
export function marketplaceManualState(publication: {
  platform: string;
  status: string;
  attempts: number;
  progress: unknown;
}): MarketplaceManualState | null {
  if (publication.platform !== "fb_marketplace" || publication.progress == null) return null;
  const parsed = marketplaceProgressSchema.safeParse(publication.progress);
  if (!parsed.success || parsed.data.attempt !== publication.attempts) return null;
  const progress = parsed.data;
  const windowClosedAt =
    progress.windowClosedAt === undefined ? null : new Date(progress.windowClosedAt);
  return {
    formReadyAt: new Date(progress.formReadyAt),
    simulated: progress.simulated,
    windowOpen:
      publication.status === "awaiting_manual_confirm" &&
      !progress.simulated &&
      windowClosedAt === null,
    windowClosedAt,
    photos: progress.photos,
    priceClp: progress.priceClp,
    ufValue: progress.ufValue ?? null,
    ufDate: progress.ufDate ?? null,
  };
}

/**
 * Cuánto espera la CLI el enlace del aviso después del formulario listo: los 30 min de
 * `MARKETPLACE_CONFIRM_TIMEOUT_MIN` (por defecto) y un margen. Deja de esperar antes si la ventana
 * se cerró (`windowClosedAt`).
 */
export const MARKETPLACE_CONFIRM_CLIENT_WAIT_MS = 31 * 60_000;

/**
 * El precio que se escribió en el formulario (spec F5 §4.6, D9): `$238.559.452`, y si se convirtió
 * desde UF, el valor usado (`$238.559.452 (UF del 2026-10-09: $41.130,94)`). La CLI y el panel.
 */
export function marketplacePriceText(
  manual: Pick<MarketplaceManualState, "priceClp" | "ufValue" | "ufDate">,
): string {
  const price = formatPrice(manual.priceClp, "CLP");
  if (manual.ufValue === null) return price;
  const uf = `$${formatNumber(Number(manual.ufValue))}`;
  return `${price} (UF${manual.ufDate === null ? "" : ` del ${manual.ufDate}`}: ${uf})`;
}
