import type { Language } from "../enums.js";
import type { NewCardText, PostCardText } from "../post-card-texts.js";

/**
 * Los textos de las láminas de cada post (`post_card_texts`, spec F9.7 B5, ADR-0043). Errores:
 * de un post que no existe → `CARD_TEXTS_REFERENCE_INVALID`; fallo de conexión → `DB_UNAVAILABLE`.
 */
export interface PostCardTextRepository {
  /** Las láminas del post (todos los idiomas), por idioma y posición. */
  list(postId: string): Promise<PostCardText[]>;
  /**
   * Reemplaza las láminas de un idioma, en una transacción. Con `fromAi`, son las de la IA
   * (`approved = false`) y **no** pisan un idioma que el operador ya revisó (alguna aprobada):
   * devuelve `false` sin cambiar nada. Sin `fromAi`, son del operador (`approved = true`).
   */
  replace(
    postId: string,
    language: Language,
    texts: readonly NewCardText[],
    options: { fromAi: boolean },
  ): Promise<boolean>;
}
