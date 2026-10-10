import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  type MarketplaceProfile,
  marketplaceProfileDir,
  openMarketplaceProfile,
} from "../../src/marketplace/profile.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** Una página local que responde a una ruta de `https://www.facebook.com`. */
export type FakeFacebookRoutes = Record<string, string>;

/** Las rutas por defecto: el formulario, el aviso publicado y lo demás de prueba. */
export const DEFAULT_ROUTES: FakeFacebookRoutes = {
  "/marketplace/create/rental": "form.html",
  "/marketplace/create/rental/paso-2": "form.html",
  "/marketplace/item/123/": "item.html",
  "/marketplace/item/999/": "item.html",
  "/marketplace/you/selling/": "unknown.html",
  "/": "unknown.html",
};

/**
 * Un Facebook falso para los tests de Marketplace (spec F5-T02): el perfil se abre sin ventana en
 * un temporal y **toda** petición pasa por `context.route`. Las de `https://www.facebook.com` que
 * tienen página local se responden desde `fixtures/`; cualquier otra se corta y queda en
 * `unexpected`, que cada test exige vacía. Así ningún test sale a Facebook ni a otro lado.
 */
export async function createFakeFacebook(routes: FakeFacebookRoutes = DEFAULT_ROUTES) {
  const root = await mkdtemp(join(tmpdir(), "agentsales-fb-"));
  const served: string[] = [];
  const unexpected: string[] = [];
  const opened: MarketplaceProfile[] = [];

  const prepare = async (context: BrowserContext) => {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const fixture = url.origin === "https://www.facebook.com" ? routes[url.pathname] : undefined;
      if (fixture === undefined) {
        unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      served.push(url.pathname);
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: await readFile(join(FIXTURES, fixture), "utf8"),
      });
    });
  };

  return {
    root,
    served,
    unexpected,
    profileDir: (brokerId = "broker-1") => marketplaceProfileDir(root, brokerId),
    /** Abre el perfil de un corredor sin ventana, con la red del Facebook falso. */
    async open(brokerId = "broker-1", options: { cookies?: Record<string, string> } = {}) {
      const profile = await openMarketplaceProfile({
        dir: marketplaceProfileDir(root, brokerId),
        headless: true,
        prepare: async (context) => {
          await prepare(context);
          const cookies = Object.entries(options.cookies ?? {});
          if (cookies.length > 0) {
            await context.addCookies(
              cookies.map(([name, value]) => ({
                name,
                value,
                domain: ".facebook.com",
                path: "/",
                secure: true,
              })),
            );
          }
        },
      });
      opened.push(profile);
      return profile;
    },
    async cleanup() {
      await Promise.all(opened.map((profile) => profile.close()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type FakeFacebook = Awaited<ReturnType<typeof createFakeFacebook>>;
