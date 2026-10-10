import { isAppError } from "../errors.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";

/**
 * Los errores que dicen que la plataforma rechazó el acceso de la cuenta (ADR-0015 punto 4):
 * Instagram (`IG_AUTH_INVALID`, un 190) y Mercado Libre (`ML_AUTH_INVALID`, también el 401
 * repetido después de refrescar, `rejected_after_refresh`, o un refresco rechazado).
 */
// `MARKETPLACE_SESSION_EXPIRED`: Facebook pidió iniciar sesión (spec F5 §4.2); se reconecta igual.
const ACCESS_REJECTED = new Set([
  "IG_AUTH_INVALID",
  "ML_AUTH_INVALID",
  "MARKETPLACE_SESSION_EXPIRED",
]);

export const isAccessRejected = (error: unknown): boolean =>
  isAppError(error) && ACCESS_REJECTED.has(error.code);

/**
 * Si `error` dice que la plataforma rechazó el acceso, deja la cuenta `expired` (condicional
 * desde `connected`: si el refresco ya la marcó, no cambia nada). La comparten el intento de
 * publicación, las operaciones y el sync (spec F4 §4.3 y T17). Un fallo al guardar el estado no
 * corta: va a `onFailure`. Devuelve si el error era de acceso.
 */
export async function expireAccountIfRejected(
  platformAccounts: Pick<PlatformAccountRepository, "changeStatus">,
  accountId: string,
  error: unknown,
  onFailure: (failure: unknown) => void,
): Promise<boolean> {
  if (!isAccessRejected(error)) return false;
  await platformAccounts.changeStatus(accountId, "connected", "expired").catch(onFailure);
  return true;
}
