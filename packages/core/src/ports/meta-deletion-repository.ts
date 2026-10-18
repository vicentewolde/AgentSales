// Las vueltas de Meta (spec F8 §4.11, D18): quitar la app y borrar los datos de un usuario de
// Instagram. El usuario llega con su `user_id` con alcance de la app, que se compara con el
// `external_account_id` de las cuentas de Instagram (que coincida con el de `/me` es NO VERIFICADO).

/** El nombre que queda en una cuenta cuyos datos se borraron a pedido de Meta. */
export const ERASED_ACCOUNT_DISPLAY_NAME = "(datos borrados a pedido de Meta)";

/**
 * El id externo que reemplaza al de Instagram en una cuenta borrada: único (lleva el id de la
 * cuenta, por la restricción de corredor, plataforma y cuenta externa) y nunca un id de Instagram.
 */
export const erasedExternalAccountId = (accountId: string): string => `borrada:${accountId}`;

/** Un pedido de borrado de Meta (`meta_deletion_requests`): sin el `user_id`, solo su hash. */
export type MetaDeletionRequest = {
  /** El código que se devuelve a Meta y que muestra la página de estado. */
  code: string;
  /** Hoy el borrado se hace al recibirlo: siempre `completed`. */
  status: "completed";
  receivedAt: Date;
  completedAt: Date | null;
  /** Cuántas cuentas de Instagram se borraron (0 si el usuario no calzó con ninguna). */
  accountsAffected: number;
};

/** Lo que anota `eraseInstagramUser`. */
export type MetaDeletionInput = {
  /** El `user_id` del `signed_request`: se busca, pero no se guarda. */
  instagramUserId: string;
  /** El hash del `user_id` (lo que sí se guarda, para reconocer un pedido repetido). */
  instagramUserIdHash: string;
  code: string;
  receivedAt: Date;
};

export interface MetaDeletionRepository {
  /**
   * Quitar la app: las cuentas de Instagram de ese usuario que tengan credenciales pasan a
   * `revoked` y se borran sus credenciales (como `disconnect`). Devuelve cuántas cambiaron.
   */
  deauthorizeInstagramUser(instagramUserId: string): Promise<number>;
  /**
   * Borrar los datos, todo en una transacción: cada cuenta de Instagram de ese usuario queda
   * `revoked`, sin credenciales, sin su id externo (se reemplaza por uno que no es de Instagram) ni
   * su nombre ni su `meta`; sus publicaciones quedan sin `external_id`, `external_url` ni
   * `progress` (los ids de Instagram), **sin cambiar su estado**, con un evento `data_deleted` cada
   * una, y sin el nombre de la cuenta en lo enviado de sus intentos. Anota el pedido y lo devuelve.
   */
  eraseInstagramUser(input: MetaDeletionInput): Promise<MetaDeletionRequest>;
  /** El pedido de ese código, o `null`. */
  getByCode(code: string): Promise<MetaDeletionRequest | null>;
}
