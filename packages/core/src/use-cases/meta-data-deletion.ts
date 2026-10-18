import type { SecretTokens } from "../ports/auth.js";
import type {
  MetaDeletionRepository,
  MetaDeletionRequest,
} from "../ports/meta-deletion-repository.js";

// Las vueltas de Meta (spec F8 §4.11, D18). La firma ya la verificó la API (con la clave de la app,
// `createSignedRequestVerifier` de config): aquí llega solo el `user_id` de Instagram.

export type MetaCallbackDeps = {
  metaDeletion: MetaDeletionRepository;
  /** El código del pedido (`generate`, base64url). */
  tokens: Pick<SecretTokens, "generate">;
  /** El hash del `user_id` que se guarda (`createMetaUserIdHasher` de config: HMAC con clave). */
  hashUserId: (userId: string) => string;
  now?: () => Date;
};

/** El código de un pedido como lo genera `SecretTokens` (base64url): la página rechaza otro. */
export const META_DELETION_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Quitar la app: desconecta las cuentas de ese usuario de Instagram (sin borrar sus datos). */
export async function handleMetaDeauthorize(
  deps: Pick<MetaCallbackDeps, "metaDeletion">,
  input: { instagramUserId: string },
): Promise<{ accounts: number }> {
  return { accounts: await deps.metaDeletion.deauthorizeInstagramUser(input.instagramUserId) };
}

/**
 * Borrar los datos: los borra de inmediato (Platform Terms 3.d.i) y anota el pedido. Un usuario que
 * no calza con ninguna cuenta recibe igual su código, sin borrar nada (spec F8 §4.11).
 */
export async function handleMetaDataDeletion(
  deps: MetaCallbackDeps,
  input: { instagramUserId: string },
): Promise<MetaDeletionRequest> {
  return deps.metaDeletion.eraseInstagramUser({
    instagramUserId: input.instagramUserId,
    instagramUserIdHash: deps.hashUserId(input.instagramUserId),
    code: deps.tokens.generate(),
    receivedAt: (deps.now ?? (() => new Date()))(),
  });
}

/** El estado de un pedido para su página: `null` si el código no tiene forma o no existe. */
export async function getMetaDeletionRequest(
  deps: Pick<MetaCallbackDeps, "metaDeletion">,
  code: string,
): Promise<MetaDeletionRequest | null> {
  if (!META_DELETION_CODE_PATTERN.test(code)) return null;
  return deps.metaDeletion.getByCode(code);
}
