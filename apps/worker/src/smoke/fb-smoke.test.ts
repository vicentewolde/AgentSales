import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Broker } from "@agentsales/core";
import {
  type MarketplaceProfile,
  marketplaceProfileDir,
  openMarketplaceProfile,
} from "@agentsales/publishers/marketplace";
import { afterEach, describe, expect, it } from "vitest";
import { runFbSmoke } from "./fb-smoke.js";

// Páginas inventadas: imitan lo mínimo de Facebook. Una app no importa los `test/` de un paquete,
// así que el test arma su propio Facebook falso (como `ig-smoke.test.ts` con msw).
const FORM = `<!doctype html><html lang="es"><body>
  <header>Nombre Inventado del Operador</header>
  <div role="main"><form aria-label="Propiedad en venta o alquiler">
    <label>Fotos <input type="file" /></label>
    <label>Precio <input type="text" name="precio" /></label>
    <button type="button" id="publicar" onclick="window.__clicks=(window.__clicks||[]).concat('publicar')">Publicar</button>
  </form></div></body></html>`;
const LOGIN = `<!doctype html><html lang="es"><body>
  <form><label>Contraseña <input type="password" /></label></form></body></html>`;
const HOME = `<!doctype html><html lang="es"><body><h1>Inicio</h1></body></html>`;
const CHECKPOINT = `<!doctype html><html lang="es"><body><h1>Confirma tu identidad</h1></body></html>`;

type Pages = Record<string, string>;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

const broker = {
  id: "broker-1",
  slug: "agentsales-pruebas",
  name: "Corredora de Prueba",
} as Broker;

async function setup(pages: Pages, options: { cookies?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentsales-fb-smoke-"));
  const unexpected: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  let profile: MarketplaceProfile | undefined;
  let current = { ...pages };
  cleanups.push(async () => {
    await profile?.close();
    await rm(root, { recursive: true, force: true });
  });
  const deps = {
    brokers: { findBySlug: async (slug: string) => (slug === broker.slug ? broker : null) },
    openProfile: async (brokerId: string) => {
      profile = await openMarketplaceProfile({
        dir: marketplaceProfileDir(root, brokerId),
        headless: true,
        prepare: async (context) => {
          await context.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            const body =
              url.origin === "https://www.facebook.com" ? current[url.pathname] : undefined;
            if (body === undefined) {
              unexpected.push(`${url.origin}${url.pathname}`);
              await route.abort("blockedbyclient");
              return;
            }
            await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
          });
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
      return profile;
    },
    outputDir: join(root, "tmp", "fb-smoke"),
    now: () => new Date(),
    print: (line: string) => out.push(line),
    printError: (line: string) => errors.push(line),
    pollMs: 20,
    formWaitMs: 500,
    loginWaitMs: 3_000,
  };
  return {
    root,
    deps,
    out,
    errors,
    unexpected,
    profile: () => profile,
    setPages: (next: Pages) => {
      current = next;
    },
  };
}

describe("pnpm fb:smoke", () => {
  it("con sesión guarda el árbol y la captura del formulario, sin llenar nada, y cierra", async () => {
    const t = await setup({ "/marketplace/create/rental": FORM }, { cookies: { c_user: "1000" } });

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(0);

    const aria = await readFile(join(t.deps.outputDir, "formulario.aria.yml"), "utf8");
    expect(aria).toContain("Precio");
    expect(aria).not.toContain("Nombre Inventado del Operador");
    const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      outcome: "form",
      finalPath: "/marketplace/create/rental",
      sessionCookie: { present: true, numeric: true },
    });
    expect(JSON.stringify(summary)).not.toContain("1000");
    expect(t.profile()?.isOpen()).toBe(false);
    expect(t.unexpected).toEqual([]);
    expect(t.out.join("\n")).toContain("No se llenó nada");
  });

  it("sin sesión espera a que el operador la inicie a mano y después guarda el formulario", async () => {
    const t = await setup({ "/marketplace/create/rental": LOGIN, "/": HOME });

    const running = runFbSmoke(t.deps, { brokerSlug: broker.slug });
    await expect.poll(() => t.out.join("\n")).toContain("Inicia sesión en Facebook");
    // Lo que haría el operador en la ventana: iniciar sesión (Facebook deja la cookie y lo lleva al inicio).
    const profile = t.profile();
    if (profile === undefined) throw new Error("no se abrió el perfil");
    t.setPages({ "/marketplace/create/rental": FORM, "/": HOME });
    await profile.context.addCookies([
      { name: "c_user", value: "1000", domain: ".facebook.com", path: "/", secure: true },
    ]);
    await profile.page.goto("https://www.facebook.com/");

    await expect(running).resolves.toBe(0);
    expect(t.out.join("\n")).toContain("✓ Sesión abierta");
    expect(t.unexpected).toEqual([]);
  });

  it("sin sesión y sin que el operador la inicie, se rinde al tope", async () => {
    const t = await setup({ "/marketplace/create/rental": LOGIN });
    t.deps.loginWaitMs = 200;

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(1);
    expect(t.errors.join("\n")).toContain("Pasaron 10 minutos sin sesión");
  });

  it("ante una verificación se detiene sin captura, con solo la ruta en el resumen", async () => {
    const t = await setup(
      { "/marketplace/create/rental": CHECKPOINT },
      { cookies: { c_user: "1" } },
    );
    // Con la cookie pero en una verificación no hay sesión: espera; al tope se rinde.
    t.deps.loginWaitMs = 200;

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(1);
    expect(t.unexpected).toEqual([]);
  });

  it("con sesión pero en otra página se detiene con MARKETPLACE_FORM_CHANGED, sin captura", async () => {
    const t = await setup({ "/marketplace/create/rental": HOME }, { cookies: { c_user: "1" } });

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(1);
    const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ outcome: "unknown", files: [] });
    expect(t.errors.join("\n")).toContain("El formulario de Marketplace cambió");
  });

  it("un corredor que no existe no abre nada", async () => {
    const t = await setup({});

    await expect(runFbSmoke(t.deps, { brokerSlug: "no-existe" })).resolves.toBe(1);
    expect(t.profile()).toBeUndefined();
    expect(t.errors).toEqual(["✗ No existe el corredor no-existe"]);
  });
});
