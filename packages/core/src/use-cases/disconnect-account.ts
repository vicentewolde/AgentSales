import { AppError } from "../errors.js";
import type { PlatformAccount } from "../platform-account.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";

export type DisconnectAccountDeps = {
  platformAccounts: Pick<PlatformAccountRepository, "get" | "disconnect">;
};

/**
 * Desconecta una cuenta (spec F3 §4.6, `POST /accounts/:id/disconnect`): queda en `revoked` y sin
 * credenciales. La fila no se borra, porque la referencian sus publicaciones; las pendientes quedan
 * con `ACCOUNT_NOT_CONNECTED` hasta descartarlas o reconectar. Desconectar una ya desconectada no
 * cambia nada. Una que no existe es `ACCOUNT_NOT_FOUND` (404).
 */
export async function disconnectAccount(
  deps: DisconnectAccountDeps,
  { accountId }: { accountId: string },
): Promise<PlatformAccount> {
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  if (account.status === "revoked" && !account.hasCredentials) return account;
  return deps.platformAccounts.disconnect(accountId);
}
