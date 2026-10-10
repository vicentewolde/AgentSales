import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeFacebook,
  DEFAULT_ROUTES,
  type FakeFacebook,
} from "../../test/marketplace/fake-facebook.js";
import { captureFormEvidence, stopRecord } from "./evidence.js";
import { classifyPage, requireForm } from "./guard.js";
import { openMarketplaceProfile } from "./profile.js";
import { MARKETPLACE_FORM_URL } from "./selectors.js";
import { createMarketplaceWindow, type MarketplaceWindowClosedReason } from "./window.js";

let facebook: FakeFacebook | undefined;

const setup = async (routes = DEFAULT_ROUTES) => {
  facebook = await createFakeFacebook(routes);
  return facebook;
};

afterEach(async () => {
  const current = facebook;
  facebook = undefined;
  try {
    // Ningún test puede haber pedido algo fuera de las páginas locales (ni Facebook de verdad).
    expect(current?.unexpected ?? []).toEqual([]);
  } finally {
    await current?.cleanup();
  }
});

/** Deja pasar un rato, para afirmar que un aviso no llega dos veces. */
const settleMore = () => new Promise((resolve) => setTimeout(resolve, 150));

const withRoutes = (extra: Record<string, string>) => ({ ...DEFAULT_ROUTES, ...extra });

describe("lista blanca (requireForm)", () => {
  it("reconoce el formulario y no hace clic ni escribe nada", async () => {
    const fb = await setup();
    const { page } = await fb.open();
    await page.goto(MARKETPLACE_FORM_URL);

    await expect(requireForm(page, { timeoutMs: 2_000 })).resolves.toBeUndefined();
    expect(await classifyPage(page)).toBe("form");
    expect(
      await page.evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks),
    ).toEqual([]);
    expect(await page.locator('input[name="precio"]').inputValue()).toBe("");
    expect(fb.served).toEqual(["/marketplace/create/rental"]);
  });

  it.each([
    ["/login.php", "login.html", "MARKETPLACE_SESSION_EXPIRED"],
    ["/checkpoint/1501092823525282/", "checkpoint.html", "MARKETPLACE_VERIFICATION_REQUIRED"],
    [
      "/two_step_verification/authentication/",
      "checkpoint.html",
      "MARKETPLACE_VERIFICATION_REQUIRED",
    ],
    ["/marketplace/create/rental", "verification-text.html", "MARKETPLACE_VERIFICATION_REQUIRED"],
    ["/marketplace/create/rental", "captcha.html", "MARKETPLACE_VERIFICATION_REQUIRED"],
    ["/marketplace/create/rental", "login.html", "MARKETPLACE_SESSION_EXPIRED"],
    ["/marketplace/create/rental", "login-form.html", "MARKETPLACE_SESSION_EXPIRED"],
    ["/login.php", "captcha.html", "MARKETPLACE_VERIFICATION_REQUIRED"],
    ["/marketplace/create/rental", "unavailable.html", "MARKETPLACE_UNAVAILABLE"],
    ["/marketplace/create/rental", "unknown.html", "MARKETPLACE_FORM_CHANGED"],
  ])("en %s (%s) se detiene con %s, sin reintento", async (path, fixture, code) => {
    const fb = await setup(withRoutes({ [path]: fixture }));
    const { page } = await fb.open();
    await page.goto(`https://www.facebook.com${path}`);

    await expect(requireForm(page, { timeoutMs: 500, pollMs: 50 })).rejects.toMatchObject({
      code,
      retriable: false,
    });
  });

  it("el Facebook falso corta lo que no tiene página local (nada sale a la red)", async () => {
    const fb = await setup();
    const { page } = await fb.open();
    await page.goto("https://www.facebook.com/no-existe/").catch(() => undefined);
    await page.goto("https://example.test/").catch(() => undefined);

    expect(fb.unexpected).toEqual([
      "GET https://www.facebook.com/no-existe/",
      "GET https://example.test/",
    ]);
    fb.unexpected.length = 0;
  });

  it("la evidencia de una detención es solo la ruta, sin consulta", async () => {
    const fb = await setup(withRoutes({ "/checkpoint/1/": "checkpoint.html" }));
    const { page } = await fb.open();
    await page.goto("https://www.facebook.com/checkpoint/1/?next=correo%40ejemplo.test");

    expect(stopRecord(page)).toEqual({ path: "/checkpoint/1/" });
  });
});

describe("perfil", () => {
  it("se crea con permisos 0700 y un segundo uso del mismo perfil es MARKETPLACE_PROFILE_BUSY", async () => {
    const fb = await setup();
    const profile = await fb.open("broker-a");

    expect((await stat(fb.profileDir("broker-a"))).mode & 0o777).toBe(0o700);
    await expect(fb.open("broker-a")).rejects.toMatchObject({
      code: "MARKETPLACE_PROFILE_BUSY",
      retriable: false,
    });
    // Otro corredor tiene su propio perfil.
    const other = await fb.open("broker-b");
    expect(other.isOpen()).toBe(true);

    await profile.close();
    expect(profile.isOpen()).toBe(false);
    const again = await fb.open("broker-a");
    expect(again.isOpen()).toBe(true);
  });

  it("respeta el candado de otro proceso vivo y toma el de uno que ya murió", async () => {
    const fb = await setup();
    const lock = `${fb.profileDir("broker-c")}.lock`;
    await openMarketplaceProfile({ dir: fb.profileDir("broker-c"), headless: true }).then((p) =>
      p.close(),
    );
    await writeFile(lock, String(process.ppid));
    await expect(fb.open("broker-c")).rejects.toMatchObject({ code: "MARKETPLACE_PROFILE_BUSY" });

    await writeFile(lock, "999999999");
    const profile = await fb.open("broker-c");
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    await profile.close();
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lee el id de la cookie de sesión y nada más", async () => {
    const fb = await setup();
    const signedIn = await fb.open("broker-d", { cookies: { c_user: "100012345", xs: "secreta" } });
    expect(await signedIn.sessionUserId()).toBe("100012345");

    const odd = await fb.open("broker-e", { cookies: { c_user: "no-numerico" } });
    expect(await odd.sessionUserId()).toBeNull();
    const none = await fb.open("broker-f");
    expect(await none.sessionUserId()).toBeNull();
  });
});

describe("evidencia del formulario", () => {
  it("guarda la captura y el árbol solo del formulario (sin la barra del operador)", async () => {
    const fb = await setup();
    const { page } = await fb.open();
    await page.goto(MARKETPLACE_FORM_URL);
    await requireForm(page, { timeoutMs: 2_000 });
    const dir = join(fb.root, "evidencia");

    const evidence = await captureFormEvidence(page, dir, "formulario");

    const aria = await readFile(evidence.aria, "utf8");
    expect(aria).toContain("Precio");
    expect(aria).toContain("Publicar");
    expect(aria).not.toContain("Nombre Inventado del Operador");
    expect(aria).not.toContain("mensajes");
    expect((await readFile(evidence.screenshot)).subarray(1, 4).toString()).toBe("PNG");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("dentro de un contenedor principal, guarda el formulario y no lo que lo rodea", async () => {
    const fb = await setup(withRoutes({ "/marketplace/create/rental": "form-in-main.html" }));
    const { page } = await fb.open();
    await page.goto(MARKETPLACE_FORM_URL);
    await requireForm(page, { timeoutMs: 2_000 });

    const evidence = await captureFormEvidence(page, join(fb.root, "evidencia"), "formulario");

    const aria = await readFile(evidence.aria, "utf8");
    expect(aria).toContain("Precio");
    expect(aria).not.toContain("Nombre Inventado del Operador");
  });
});

describe("ventana vigilada", () => {
  const watched = async (fb: FakeFacebook, timeoutMs = 10_000) => {
    const profile = await fb.open();
    await profile.page.goto(MARKETPLACE_FORM_URL);
    const window = createMarketplaceWindow(profile);
    const items: string[] = [];
    const closed: MarketplaceWindowClosedReason[] = [];
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    window.watch(
      {
        onItemUrl: (url) => {
          items.push(url);
          settle();
        },
        onClosed: (reason) => {
          closed.push(reason);
          settle();
        },
      },
      { timeoutMs },
    );
    return { profile, window, items, closed, settled };
  };

  it("reconoce el aviso al publicar desde el formulario y cierra la ventana", async () => {
    const fb = await setup();
    const { profile, items, closed, settled } = await watched(fb);

    // Lo que haría el operador en la página local: el clic final.
    await profile.page.locator("#publicar").click();
    await settled;

    expect(items).toEqual(["https://www.facebook.com/marketplace/item/123/"]);
    await expect.poll(() => profile.isOpen()).toBe(false);
    await settleMore();
    expect(items).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  it("si registrar el aviso falla, avisa el error, cierra y deja la publicación esperando", async () => {
    const fb = await setup();
    const profile = await fb.open();
    await profile.page.goto(MARKETPLACE_FORM_URL);
    const window = createMarketplaceWindow(profile);
    const closed: MarketplaceWindowClosedReason[] = [];
    const errors: unknown[] = [];
    window.watch(
      {
        onItemUrl: () => {
          throw new Error("la base no respondió");
        },
        onClosed: (reason) => {
          closed.push(reason);
        },
        onError: (error) => errors.push(error),
      },
      { timeoutMs: 10_000 },
    );

    await profile.page.locator("#publicar").click();

    await expect.poll(() => closed).toEqual(["closed"]);
    expect(errors).toHaveLength(1);
    expect(profile.isOpen()).toBe(false);
  });

  it("los pasos dentro del flujo de crear siguen esperando el aviso", async () => {
    const fb = await setup();
    const { profile, items, settled } = await watched(fb);

    await profile.page.locator("#paso-2").click();
    await profile.page.waitForURL("**/marketplace/create/rental/paso-2");
    await profile.page.locator("#publicar").click();
    await settled;

    expect(items).toEqual(["https://www.facebook.com/marketplace/item/123/"]);
  });

  it("si la primera salida del formulario no es un aviso, deja de mirar (un aviso ajeno no cuenta)", async () => {
    const fb = await setup();
    const { profile, window, items, closed } = await watched(fb);

    await profile.page.locator("#mis-avisos").click();
    await profile.page.waitForURL("**/marketplace/you/selling/");
    await profile.page.goto("https://www.facebook.com/marketplace/item/999/");

    expect(items).toEqual([]);
    expect(closed).toEqual([]);
    expect(window.isOpen()).toBe(true);
    await window.close();
    expect(closed).toEqual([]);
  });

  it("un aviso abierto en otra pestaña no cuenta", async () => {
    const fb = await setup();
    const { profile, window, items } = await watched(fb);

    const other = await profile.context.newPage();
    await other.goto("https://www.facebook.com/marketplace/item/999/");

    expect(items).toEqual([]);
    expect(window.isOpen()).toBe(true);
  });

  it("si el operador cierra la ventana, avisa una vez sin ver el aviso", async () => {
    const fb = await setup();
    const { profile, items, closed, settled } = await watched(fb);

    await profile.context.close();
    await settled;

    expect(closed).toEqual(["closed"]);
    expect(items).toEqual([]);
    await settleMore();
    expect(closed).toHaveLength(1);
  });

  it("cerrar solo la pestaña del formulario también suelta el perfil", async () => {
    const fb = await setup();
    const { profile, closed, settled } = await watched(fb);

    await profile.page.close();
    await settled;

    expect(closed).toEqual(["closed"]);
    await expect.poll(() => profile.isOpen()).toBe(false);
    const again = await fb.open();
    expect(again.isOpen()).toBe(true);
  });

  it("al vencer el tope cierra la ventana y avisa", async () => {
    const fb = await setup();
    const { profile, closed, settled } = await watched(fb, 300);

    await settled;

    expect(closed).toEqual(["timeout"]);
    expect(profile.isOpen()).toBe(false);
  });
});
