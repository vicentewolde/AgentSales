import { AppError } from "../errors.js";
import { manualConfirmPending } from "../marketplace/limits.js";
import { type PlatformAccount, usesSessionProfile } from "../platform-account.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";

export type DisconnectAccountDeps = {
  platformAccounts: Pick<PlatformAccountRepository, "get" | "disconnect">;
  /** Marketplace: para no desconectar con un formulario esperando el clic final (spec F5 §4.2). */
  publications: Pick<PublicationRepository, "listByStatus">;
  /** Marketplace: el borrado del perfil lo hace el worker (`marketplace.profile`, ADR-0017). */
  queue: Pick<JobQueue, "enqueue">;
};

/**
 * Desconecta una cuenta (spec F3 §4.6, `POST /accounts/:id/disconnect`): queda en `revoked` y sin
 * credenciales. La fila no se borra, porque la referencian sus publicaciones; las pendientes quedan
 * con `ACCOUNT_NOT_CONNECTED` hasta descartarlas o reconectar. Desconectar una ya desconectada no
 * cambia nada. Una que no existe es `ACCOUNT_NOT_FOUND` (404).
 *
 * Marketplace (spec F5 §4.2, ADR-0017), además:
 * - exige `confirmed` (borra el perfil, con la sesión de Facebook) → `DISCONNECT_NOT_CONFIRMED`;
 * - con una publicación de la cuenta esperando el clic final → `MANUAL_CONFIRM_PENDING` (primero
 *   el operador dice si la publicó), y con una que se está llenando → `PUBLICATION_IN_PROGRESS`;
 * - encola **primero** `marketplace.profile` (`forget`): el worker, dueño del perfil, cierra sus
 *   ventanas y borra la carpeta (borrar un perfil todavía conectado no hace daño: la base se cambia
 *   enseguida). Si la cola ya tiene otra acción del perfil esperando (`null`, cola `stately`),
 *   `MARKETPLACE_PROFILE_ACTION_PENDING` (409) sin tocar la base: se reintenta en un momento. Un
 *   `forget` detrás de un login en curso espera su turno, y ese login no conecta (vio la
 *   desconexión). Se encola también si ya estaba desconectada (idempotente: repara un borrado que
 *   falló). Después, la cuenta pasa a `revoked`.
 */
export async function disconnectAccount(
  deps: DisconnectAccountDeps,
  { accountId, confirmed = false }: { accountId: string; confirmed?: boolean },
): Promise<PlatformAccount> {
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  const profile = usesSessionProfile(account.platform);
  if (profile) {
    if (!confirmed) {
      throw new AppError(
        "DISCONNECT_NOT_CONFIRMED",
        "Desconectar Marketplace borra el perfil del navegador con la sesión de Facebook: confirma para seguir",
        { details: { accountId } },
      );
    }
    const waiting = (await deps.publications.listByStatus("awaiting_manual_confirm")).find(
      (publication) => publication.platformAccountId === accountId,
    );
    if (waiting !== undefined) throw manualConfirmPending(waiting.id);
    const filling = (await deps.publications.listByStatus("publishing")).find(
      (publication) => publication.platformAccountId === accountId,
    );
    if (filling !== undefined) {
      throw new AppError(
        "PUBLICATION_IN_PROGRESS",
        "Se está llenando un formulario de Marketplace de esta cuenta: espera a que termine",
        { details: { publicationId: filling.id } },
      );
    }
    const queued = await deps.queue.enqueue(
      "marketplace.profile",
      { brokerId: account.brokerId, action: "forget" },
      { singletonKey: account.brokerId },
    );
    if (queued === null) {
      throw new AppError(
        "MARKETPLACE_PROFILE_ACTION_PENDING",
        "Ya hay una acción del perfil de Facebook esperando (un inicio de sesión o un borrado): reintenta en un momento",
        { details: { accountId } },
      );
    }
  }
  return account.status === "revoked" && !account.hasCredentials
    ? account
    : deps.platformAccounts.disconnect(accountId);
}
