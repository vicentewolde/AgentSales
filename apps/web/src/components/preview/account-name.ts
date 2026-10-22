import { accountOwnedBy, PLATFORM_TEXT, type Platform } from "@agentsales/core";
import { useAccounts } from "../../queries/accounts.js";

/** El nombre que se ve mientras no se saben las cuentas, o si la cuenta conectada no trae nombre. */
export const ACCOUNT_NAME_FALLBACK = "tu cuenta";

/** Lo que se ve si el corredor o la marca no tiene ninguna cuenta de esa red (F9.5-T20). */
export const accountNameUnconnected = (platform: Platform): string =>
  `${PLATFORM_TEXT[platform]} sin conectar`;

/**
 * El nombre de la cuenta de un corredor o marca en una red, para la vista previa (F9.5-T07): el de
 * la cuenta conectada (`@usuario` en Instagram y X, el nombre del webhook en Discord), o el de
 * cualquiera de sus cuentas de esa red. Sin ninguna dice «Instagram sin conectar» (F9.5-T20), y
 * mientras carga o si la cuenta no trae nombre, «tu cuenta». Como
 * `useBrandPlatforms` (F9.5-T12), las cuentas se piden con el alcance de la sesión, no con el
 * corredor del selector, y se eligen las suyas con `accountOwnedBy`.
 */
export function useAccountName(brokerId: string | undefined, platform: Platform): string {
  const accounts = useAccounts();
  const mine =
    brokerId === undefined
      ? []
      : (accounts.data?.accounts ?? []).filter(
          (account) => accountOwnedBy(account, brokerId) && account.platform === platform,
        );
  const account = mine.find((item) => item.status === "connected") ?? mine[0];
  if (account === undefined) {
    return accounts.data === undefined ? ACCOUNT_NAME_FALLBACK : accountNameUnconnected(platform);
  }
  return account.displayName ?? ACCOUNT_NAME_FALLBACK;
}
