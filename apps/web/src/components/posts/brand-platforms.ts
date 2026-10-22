import { accountOwnedBy, POST_PLATFORMS, type PostPlatform, postPlatforms } from "@agentsales/core";
import { useAccounts } from "../../queries/accounts.js";
import { useEditorialProfile } from "../../queries/posts.js";

/**
 * Las redes de una marca (F9-T21): con cuenta o con cadencia en su perfil, la misma regla de core
 * (`postPlatforms`) que usan el plan y los textos. Mientras no se sabe, todas las de los posts.
 * Las cuentas se piden con el alcance de la sesión, no con el corredor del selector, y se eligen
 * las de la marca con `accountOwnedBy` (F9.5-T12): un administrador con otro corredor elegido ve
 * igual las redes de la marca que mira.
 */
export function useBrandPlatforms(brandId: string | undefined): readonly PostPlatform[] {
  const profile = useEditorialProfile(brandId);
  const accounts = useAccounts();
  if (profile.data === undefined || accounts.data === undefined || brandId === undefined) {
    return POST_PLATFORMS;
  }
  return postPlatforms(
    profile.data,
    accounts.data.accounts.filter((account) => accountOwnedBy(account, brandId)),
  );
}
