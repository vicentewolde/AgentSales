import type { PlatformAccount } from "../platform-account.js";

/**
 * Si una cuenta conectada es **de** ese corredor o marca (spec F9.5 §4.2): la única regla de «la
 * cuenta de la marca» para la lista de alta (`onboardingSteps`), la página de Cuentas y las redes
 * de un post en el panel.
 *
 * Dice de quién es la cuenta; **no es un control de acceso**. Quién puede ver o usar una cuenta
 * lo deciden `scopeOf`, `inScope` y `can` (ADR-0029 punto 13): esta función solo elige, entre las
 * cuentas que ya se pueden ver, las que pertenecen a un corredor.
 */
export function accountOwnedBy(
  account: Pick<PlatformAccount, "brokerId">,
  brokerId: string,
): boolean {
  return account.brokerId === brokerId;
}
