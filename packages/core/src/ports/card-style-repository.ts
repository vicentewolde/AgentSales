import type { BrandCardStyle, CardStyle } from "../card-style.js";

/**
 * El estilo de las imágenes de cada marca (`brand_card_styles`, spec F9.7 B4, ADR-0043) y el tema
 * de cada post (`posts.card_theme`). Errores (`AppError`):
 * - `save` de un corredor que no existe → `CARD_STYLE_REFERENCE_INVALID`;
 * - una fila que no calza con `cardStyleSchema` → `CARD_STYLE_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface CardStyleRepository {
  /** El estilo de la marca; `null` si no tiene (las tarjetas se dibujan como antes). */
  get(brokerId: string): Promise<BrandCardStyle | null>;
  /** Crea o reemplaza el estilo y sube su `version`. */
  save(brokerId: string, style: CardStyle): Promise<BrandCardStyle>;
  /**
   * El tema del post: el que ya tiene o, la primera vez, el siguiente de la rotación de su marca
   * (cuántos posts de la marca ya tienen tema, módulo `themes`), que queda fijo.
   */
  assignTheme(postId: string, brokerId: string, themes: number): Promise<number>;
}
