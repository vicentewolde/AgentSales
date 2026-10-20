import { POST_PLATFORMS, type PostPlatform, postPlatforms } from "@agentsales/core";
import { useAccounts } from "../../queries/accounts.js";
import { useEditorialProfile } from "../../queries/posts.js";
import { useBrokerFilter } from "../../scope/broker-scope.js";

/**
 * Las redes de una marca (F9-T21): con cuenta o con cadencia en su perfil, la misma regla de core
 * (`postPlatforms`) que usan el plan y los textos. Mientras no se sabe, todas las de los posts.
 */
export function useBrandPlatforms(brandId: string | undefined): readonly PostPlatform[] {
  const profile = useEditorialProfile(brandId);
  const accounts = useAccounts(useBrokerFilter());
  if (profile.data === undefined || accounts.data === undefined) return POST_PLATFORMS;
  return postPlatforms(
    profile.data,
    accounts.data.accounts.filter((account) => account.brokerId === brandId),
  );
}
