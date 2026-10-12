import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MarketplaceProfile,
  marketplaceProfileDir,
  openMarketplaceProfile,
} from "@agentsales/publishers/marketplace";

/**
 * Las páginas locales del formulario de Marketplace. Una app no importa los `test/` de un paquete,
 * así que se leen como archivos los **mismos** fixtures de `packages/publishers` (el formulario se
 * arma desde el árbol real de `fb:smoke`; mantener una sola copia evita que se separen).
 */
export const MARKETPLACE_FIXTURES = join(
  import.meta.dirname,
  "../../../packages/publishers/test/marketplace/fixtures",
);

/**
 * Un Facebook falso para las pruebas del worker (spec F5, `docs/05-convenciones.md`): perfiles sin
 * ventana en un temporal y **toda** petición por `context.route`. Las de `https://www.facebook.com`
 * con página local se responden desde los fixtures; cualquier otra se corta y queda en
 * `unexpected`, que cada test exige vacía.
 */
export async function createWorkerFakeFacebook(pages: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "agentsales-fb-worker-"));
  const unexpected: string[] = [];
  const profiles: MarketplaceProfile[] = [];
  return {
    root,
    unexpected,
    profiles,
    async openProfile(brokerId: string): Promise<MarketplaceProfile> {
      const profile = await openMarketplaceProfile({
        dir: marketplaceProfileDir(join(root, "perfiles"), brokerId),
        headless: true,
        prepare: async (context) => {
          await context.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            const fixture =
              url.origin === "https://www.facebook.com" ? pages[url.pathname] : undefined;
            if (fixture === undefined) {
              unexpected.push(`${url.origin}${url.pathname}`);
              await route.abort("blockedbyclient");
              return;
            }
            await route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: await readFile(join(MARKETPLACE_FIXTURES, fixture), "utf8"),
            });
          });
        },
      });
      profiles.push(profile);
      return profile;
    },
    async cleanup() {
      for (const profile of profiles) await profile.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type WorkerFakeFacebook = Awaited<ReturnType<typeof createWorkerFakeFacebook>>;
