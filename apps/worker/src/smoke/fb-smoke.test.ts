import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Broker } from "@agentsales/core";
import {
  type MarketplaceProfile,
  marketplaceProfileDir,
  openMarketplaceProfile,
} from "@agentsales/publishers/marketplace";
import { afterEach, describe, expect, it } from "vitest";
import { FB_SMOKE_MAX_MENU_CAPTURES, type FbSmokeDeps, runFbSmoke } from "./fb-smoke.js";

// Páginas inventadas: imitan lo mínimo de Facebook. Una app no importa los `test/` de un paquete,
// así que el test arma su propio Facebook falso (como `ig-smoke.test.ts` con msw).
const FORM = `<!doctype html><html lang="es"><body>
  <header>Nombre Inventado del Operador</header>
  <div role="main"><form aria-label="Propiedad en venta o alquiler">
    <label>Fotos <input type="file" /></label>
    <label>Precio <input type="text" name="precio" /></label>
    <button type="button" id="publicar" onclick="window.__clicks=(window.__clicks||[]).concat('publicar')">Publicar</button>
  </form></div></body></html>`;
// Con un menú cuya lista se dibuja fuera del formulario y el menú de la cuenta en la barra.
const FORM_MENUS = `<!doctype html><html lang="es"><body>
  <div role="banner"><div role="menu" aria-label="Tu cuenta"><div role="menuitem">Nombre Inventado del Operador</div></div></div>
  <div role="main"><form aria-label="Propiedad en venta o alquiler">
    <label>Fotos <input type="file" /></label>
    <div role="combobox" id="combo-tipo" aria-label="Tipo de propiedad" aria-expanded="false" tabindex="0">Tipo de propiedad</div>
    <label>Precio <input type="text" name="precio" /></label>
  </form></div>
  <div role="listbox" aria-label="Tipo de propiedad" id="lista-tipo" hidden>
    <div role="option">Departamento</div><div role="option">Casa</div>
  </div>
  <script>document.addEventListener("click", () => { window.__clicks = (window.__clicks || 0) + 1; });</script>
  </body></html>`;
// Como probablemente Facebook: un form solo con las fotos y los campos aparte, dentro del main.
const FORM_FOTOS_APARTE = `<!doctype html><html lang="es"><body>
  <header>Nombre Inventado del Operador</header>
  <div role="main">
    <form aria-label="Subir fotos"><label>Fotos <input type="file" /></label></form>
    <div aria-label="Propiedad en venta o alquiler">
      <label>Precio <input type="text" name="precio" /></label>
      <label>Dormitorios <input type="text" name="dormitorios" /></label>
      <label>Baños <input type="text" name="banos" /></label>
      <label>Descripción <textarea name="descripcion"></textarea></label>
      <div role="combobox" aria-label="Tipo de propiedad" aria-expanded="false" tabindex="0">Tipo de propiedad</div>
      <label>Dirección <input type="text" name="ubicacion" /></label>
      <label>Metros cuadrados <input type="text" name="m2" /></label>
      <label>Título <input type="text" name="titulo" /></label>
    </div>
  </div></body></html>`;
// Un form que solo trae el control de fotos y nada más: el árbol saldría casi vacío.
const FORM_SOLO_FOTOS = `<!doctype html><html lang="es"><body>
  <form><label>Fotos <input type="file" /></label></form></body></html>`;
const LOGIN = `<!doctype html><html lang="es"><body>
  <form><label>Contraseña <input type="password" /></label></form></body></html>`;
const HOME = `<!doctype html><html lang="es"><body><h1>Inicio</h1></body></html>`;
const UNAVAILABLE = `<!doctype html><html lang="es"><body><h1>Marketplace no está disponible para ti</h1></body></html>`;
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
  const deps: FbSmokeDeps = {
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
    let page: { clicks: unknown; price: string } | undefined;
    t.deps.beforeClose = async (profile) => {
      page = {
        clicks: await profile.page.evaluate(() => (globalThis as { __clicks?: unknown }).__clicks),
        price: await profile.page.locator('input[name="precio"]').inputValue(),
      };
    };

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
    // Nada escrito ni clicado en la página, y el resumen sin rutas del disco.
    expect(page).toEqual({ clicks: undefined, price: "" });
    expect(summary.files).toEqual(["formulario.aria.yml", "formulario.png"]);
  });

  it("guarda el contenedor con los campos aunque las fotos vivan en un form aparte, y anota su forma sin textos", async () => {
    const t = await setup(
      { "/marketplace/create/rental": FORM_FOTOS_APARTE },
      { cookies: { c_user: "1000" } },
    );

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(0);

    const aria = await readFile(join(t.deps.outputDir, "formulario.aria.yml"), "utf8");
    expect(aria).toContain("Precio");
    expect(aria).toContain('combobox "Tipo de propiedad"');
    expect(aria).not.toContain("Nombre Inventado del Operador");
    const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
    expect(summary.ariaLines).toBeGreaterThanOrEqual(8);
    expect(summary.shape.slice(0, 3).map((step: { tag: string }) => step.tag)).toEqual([
      "label",
      "form",
      "div",
    ]);
    expect(summary.shape[1]).toMatchObject({ fields: 0, photoInputs: 1 });
    // Solo etiquetas, roles y cuentas: ningún texto de la página.
    expect(JSON.stringify(summary.shape)).not.toMatch(/Precio|Nombre Inventado/);
    expect(t.out.join("\n")).toContain(
      "✓ Guardé el formulario: formulario.aria.yml y formulario.png",
    );
    expect(t.errors).toEqual([]);
  });

  it("avisa cuando el árbol del formulario sale casi vacío", async () => {
    const t = await setup(
      { "/marketplace/create/rental": FORM_SOLO_FOTOS },
      { cookies: { c_user: "1000" } },
    );

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(0);
    expect(t.errors.join("\n")).toContain("salió casi vacío");
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
    expect(t.errors.join("\n")).toContain("Pasaron 1 minuto sin sesión");
  });

  it("ante una verificación pide resolverla a mano en la ventana, espera y se rinde al tope", async () => {
    const t = await setup(
      { "/marketplace/create/rental": CHECKPOINT },
      { cookies: { c_user: "1" } },
    );
    t.deps.loginWaitMs = 200;

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(1);
    expect(t.out.join("\n")).toContain("resuélvela a mano en esa ventana");
    expect(t.errors.join("\n")).toContain("sin sesión");
    expect(t.unexpected).toEqual([]);
  });

  it("con sesión y Marketplace no disponible se detiene sin captura, con solo la ruta", async () => {
    const t = await setup(
      { "/marketplace/create/rental": UNAVAILABLE },
      { cookies: { c_user: "1" } },
    );

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(1);
    const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      outcome: "unavailable",
      finalPath: "/marketplace/create/rental",
      files: [],
    });
    await expect(readFile(join(t.deps.outputDir, "formulario.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(t.errors.join("\n")).toContain("Marketplace no está disponible");
  });

  it("si el operador cierra la ventana mientras espera, termina sin girar en vacío", async () => {
    const t = await setup({ "/marketplace/create/rental": LOGIN });

    const running = runFbSmoke(t.deps, { brokerSlug: broker.slug });
    await expect.poll(() => t.out.join("\n")).toContain("Inicia sesión en Facebook");
    await t.profile()?.context.close();

    await expect(running).resolves.toBe(1);
    expect(t.errors.join("\n")).toContain("Se cerró la ventana");
  });

  it("con sesión pero en otra página se detiene con MARKETPLACE_FORM_CHANGED, sin captura", async () => {
    const t = await setup({ "/marketplace/create/rental": HOME }, { cookies: { c_user: "1" } });

    await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(1);
    const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ outcome: "unknown", files: [] });
    expect(t.errors.join("\n")).toContain("El formulario de Marketplace cambió");
  });

  describe("--menus", () => {
    /** El operador en la terminal: cada respuesta, después de lo que hace a mano en la ventana. */
    const operator = (
      t: Awaited<ReturnType<typeof setup>>,
      steps: Array<{
        before?: (page: MarketplaceProfile["page"]) => Promise<unknown>;
        answer: string | null;
      }>,
    ) => {
      const questions: string[] = [];
      t.deps.ask = async (question) => {
        questions.push(question);
        const step = steps.shift();
        const page = t.profile()?.page;
        if (step?.before !== undefined && page !== undefined) await step.before(page);
        return step === undefined ? null : step.answer;
      };
      return questions;
    };
    const openList = (page: MarketplaceProfile["page"]) =>
      page.evaluate(`document.getElementById("combo-tipo").setAttribute("aria-expanded", "true");
        document.getElementById("lista-tipo").removeAttribute("hidden");`);
    const closeList = (page: MarketplaceProfile["page"]) =>
      page.evaluate(`document.getElementById("combo-tipo").setAttribute("aria-expanded", "false");
        document.getElementById("lista-tipo").setAttribute("hidden", "");`);

    it("guarda una captura por cada Enter, con la lista que abrió el operador, hasta que dice listo", async () => {
      const t = await setup(
        { "/marketplace/create/rental": FORM_MENUS },
        { cookies: { c_user: "1000" } },
      );
      const questions = operator(t, [
        { before: openList, answer: "" },
        { before: closeList, answer: "" },
        { answer: " Listo " },
      ]);
      let clicks: unknown;
      t.deps.beforeClose = async (profile) => {
        clicks = await profile.page.evaluate(() => (globalThis as { __clicks?: unknown }).__clicks);
      };

      await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug, menus: true })).resolves.toBe(0);

      expect(questions).toHaveLength(3);
      const first = await readFile(join(t.deps.outputDir, "captura-1.aria.yml"), "utf8");
      expect(first).toContain('option "Departamento"');
      expect(first).toContain('combobox "Tipo de propiedad"');
      expect(first).not.toContain("Nombre Inventado del Operador");
      const second = await readFile(join(t.deps.outputDir, "captura-2.aria.yml"), "utf8");
      expect(second).not.toContain("Departamento");
      const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
      expect(summary.files).toEqual([
        "formulario.aria.yml",
        "formulario.png",
        "captura-1.aria.yml",
        "captura-2.aria.yml",
      ]);
      const out = t.out.join("\n");
      expect(out).toContain("1 lista desplegada");
      expect(out).toContain("no vi una lista desplegada");
      expect(out).toContain("Nunca hagas clic en Siguiente ni en Publicar");
      expect(clicks).toBeUndefined();
      expect(t.profile()?.isOpen()).toBe(false);
      expect(t.unexpected).toEqual([]);
    });

    it("borra las capturas de una corrida anterior y avisa al llegar al máximo", async () => {
      const t = await setup(
        { "/marketplace/create/rental": FORM_MENUS },
        { cookies: { c_user: "1000" } },
      );
      await mkdir(t.deps.outputDir, { recursive: true });
      await writeFile(join(t.deps.outputDir, "captura-12.aria.yml"), "vieja\n");
      const questions = operator(
        t,
        Array.from({ length: FB_SMOKE_MAX_MENU_CAPTURES + 1 }, () => ({ answer: "" })),
      );

      await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug, menus: true })).resolves.toBe(0);
      expect(questions).toHaveLength(FB_SMOKE_MAX_MENU_CAPTURES);
      expect(t.out.join("\n")).toContain(`máximo de ${FB_SMOKE_MAX_MENU_CAPTURES} capturas`);
      await expect(readFile(join(t.deps.outputDir, "captura-12.aria.yml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("si el operador cierra la ventana en vez de escribir listo, termina con lo guardado", async () => {
      const t = await setup(
        { "/marketplace/create/rental": FORM_MENUS },
        { cookies: { c_user: "1000" } },
      );
      operator(t, [
        { before: openList, answer: "" },
        { before: (page) => page.context().close(), answer: "" },
      ]);

      await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug, menus: true })).resolves.toBe(0);
      expect(t.out.join("\n")).toContain("Se cerró la ventana: termino con lo guardado");
      const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
      expect(summary.files).toContain("captura-1.aria.yml");
    });

    it("si se corta la terminal, termina con lo guardado", async () => {
      const t = await setup(
        { "/marketplace/create/rental": FORM_MENUS },
        { cookies: { c_user: "1000" } },
      );
      operator(t, [{ before: openList, answer: "" }, { answer: null }]);

      await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug, menus: true })).resolves.toBe(0);
      const summary = JSON.parse(await readFile(join(t.deps.outputDir, "summary.json"), "utf8"));
      expect(summary.files).toContain("captura-1.aria.yml");
      expect(t.profile()?.isOpen()).toBe(false);
    });

    it("si la página deja de ser el formulario (una verificación), se detiene sin guardar la captura", async () => {
      const t = await setup(
        { "/marketplace/create/rental": FORM_MENUS, "/checkpoint/": CHECKPOINT },
        { cookies: { c_user: "1000" } },
      );
      operator(t, [
        { before: (page) => page.goto("https://www.facebook.com/checkpoint/"), answer: "" },
      ]);

      await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug, menus: true })).resolves.toBe(1);
      await expect(readFile(join(t.deps.outputDir, "captura-1.aria.yml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(t.errors.join("\n")).toContain("verificación");
      expect(t.profile()?.isOpen()).toBe(false);
      expect(t.unexpected).toEqual([]);
    });

    it("sin --menus no pregunta nada", async () => {
      const t = await setup(
        { "/marketplace/create/rental": FORM_MENUS },
        { cookies: { c_user: "1000" } },
      );
      const questions = operator(t, []);

      await expect(runFbSmoke(t.deps, { brokerSlug: broker.slug })).resolves.toBe(0);
      expect(questions).toEqual([]);
    });
  });

  it("un corredor que no existe no abre nada", async () => {
    const t = await setup({});

    await expect(runFbSmoke(t.deps, { brokerSlug: "no-existe" })).resolves.toBe(1);
    expect(t.profile()).toBeUndefined();
    expect(t.errors).toEqual(["✗ No existe el corredor no-existe"]);
  });
});
