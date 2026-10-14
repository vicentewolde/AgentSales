import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type PlatformAccount,
  type PublishContext,
  type PublishInput,
  withDryRun,
} from "@agentsales/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeFacebook,
  DEFAULT_ROUTES,
  type FakeFacebook,
} from "../../test/marketplace/fake-facebook.js";
import { MARKETPLACE_ERRORS } from "./errors.js";
import type { MarketplaceProfile } from "./profile.js";
import {
  createMarketplacePublisher,
  type MarketplaceHandoffRef,
  type MarketplacePublisherDeps,
  marketplaceAttemptDir,
  validateMarketplaceInput,
} from "./publisher.js";
import type { MarketplaceWindow } from "./window.js";

const input: PublishInput = {
  publicationId: "pub-1",
  platform: "fb_marketplace",
  format: "post",
  title: "Departamento en arriendo 2 dormitorios en Ñuñoa",
  caption: "Texto inventado de Marketplace.",
  media: [1, 2].map((n) => ({
    mediaId: `m-${n}`,
    kind: "image" as const,
    mime: "image/jpeg",
    storagePath: `brokers/b/listings/l/processed/pi_4x3/${n}.jpg`,
    url: `memory://foto-${n}`,
    bytes: 1000,
    width: 1600,
    height: 1200,
    durationS: null,
  })),
  listing: {
    id: "l",
    externalRef: "P001",
    operation: "rent",
    propertyType: "Departamento",
    region: "Región Metropolitana",
    comuna: "Ñuñoa",
    address: "Calle Inventada 1234",
    unitNumber: "506",
    showExactAddress: false,
    priceAmount: 650_000,
    priceCurrency: "CLP",
    attributes: { dormitorios: 2, banos: 1, sup_util_m2: 54.4 },
  },
  priceClp: 650_000,
  uf: null,
};

const account = {
  id: "acc-1",
  brokerId: "broker-1",
  platform: "fb_marketplace",
} as PlatformAccount;

const ctx: PublishContext = { account, progress: null, saveProgress: async () => undefined };

let facebook: FakeFacebook | undefined;
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

/** Un publisher con el Facebook falso, sin pausas, que registra lo que entrega y lo que cierra. */
async function setup(
  options: { routes?: Record<string, string>; deps?: Partial<MarketplacePublisherDeps> } = {},
) {
  const fb = await createFakeFacebook(options.routes ?? DEFAULT_ROUTES);
  facebook = fb;
  const handoffs: Array<{ ref: MarketplaceHandoffRef; window: MarketplaceWindow }> = [];
  const closedAccounts: string[] = [];
  const profiles: MarketplaceProfile[] = [];
  const reported: string[] = [];
  const read: string[] = [];
  const tmpRoot = join(fb.root, "tmp", "marketplace");
  const publisher = createMarketplacePublisher({
    openProfile: async (brokerId) => {
      const profile = await fb.open(brokerId);
      // Cada clic de la página se anota también aquí: se lee aunque la ventana se cierre.
      await profile.page.exposeFunction("reportClick", (what: string) => reported.push(what));
      profiles.push(profile);
      return profile;
    },
    readPhoto: async (media) => {
      read.push(media.storagePath);
      return Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    },
    tmpRoot,
    closeAccountWindows: async (accountId) => {
      closedAccounts.push(accountId);
    },
    onHandoff: async (ref, window) => {
      handoffs.push({ ref, window });
    },
    fill: { pauseMs: 0, controlWaitMs: 1_000, photosWaitMs: 5_000, guardWaitMs: 1_000 },
    formWaitMs: 2_000,
    profileBusyWaitMs: 0,
    ...options.deps,
  });
  const dir = marketplaceAttemptDir(tmpRoot, input.publicationId);
  return { fb, publisher, handoffs, closedAccounts, profiles, reported, read, dir, tmpRoot };
}

/** Los archivos de una carpeta, o ninguno si no existe (las fotos ya no pasan por el disco). */
const filesIn = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** El mismo aviso sin dirección en la planilla: solo se conoce la comuna. */
const withoutAddress: PublishInput = {
  ...input,
  listing: { ...(input.listing as NonNullable<PublishInput["listing"]>), address: null },
};

const pageOf = (t: Awaited<ReturnType<typeof setup>>) => {
  const page = t.profiles[0]?.page;
  if (page === undefined) throw new Error("no se abrió el perfil");
  return page;
};

const clicksOf = (t: Awaited<ReturnType<typeof setup>>) =>
  pageOf(t).evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks);

describe("publisher de Marketplace: validar", () => {
  it("declara el paso manual y un solo formato", async () => {
    const t = await setup();
    expect(t.publisher).toMatchObject({
      platform: "fb_marketplace",
      formats: ["post"],
      manualConfirm: true,
    });
    expect(t.publisher.validate(input)).toEqual({ ok: true });
  });

  it("valida título, fotos JPEG, el aviso y el precio en pesos", () => {
    expect(
      validateMarketplaceInput({
        ...input,
        title: "x".repeat(61),
        media: [{ ...(input.media[0] as PublishInput["media"][number]), mime: "image/png" }],
        priceClp: undefined,
      }).map((issue) => issue.code),
    ).toEqual(["TITLE_TOO_LONG", "PHOTO_NOT_JPEG", "PRICE_MISSING"]);
    expect(
      validateMarketplaceInput({ ...input, title: " ", media: [] }).map((issue) => issue.code),
    ).toEqual(["TITLE_MISSING", "PHOTOS_INVALID"]);
  });

  it("en simulación deja el formulario listo sin abrir nada", async () => {
    const t = await setup();
    await expect(withDryRun(t.publisher).publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
      simulated: true,
    });
    expect(t.profiles).toEqual([]);
    expect(t.read).toEqual([]);
  });
});

describe("publisher de Marketplace: llenar el formulario (spec F5 §4.4)", () => {
  it("llena cada control, sube las fotos, guarda la evidencia y entrega la ventana sin enviar nada", async () => {
    const t = await setup();

    const result = await t.publisher.publish(input, ctx);

    expect(result).toEqual({ handoff: "manual_confirm", simulated: false });
    const page = pageOf(t);
    const value = (name: string) => page.locator(`[name="${name}"]`).inputValue();
    // "Departamento" del Excel → la opción "Apartamento o piso" del formulario real.
    expect(await page.locator("#combo-tipo").getAttribute("data-value")).toBe("Apartamento o piso");
    expect(await value("habitaciones")).toBe("2");
    expect(await value("banos")).toBe("1");
    expect(await value("precio")).toBe("650000");
    // 54,4 m² → 586 pies cuadrados (el formulario los pide en pies).
    expect(await value("pies")).toBe("586");
    expect(await value("descripcion")).toBe("Texto inventado de Marketplace.");
    // La ubicación se busca con la dirección tal cual está en la planilla (D16), aunque no se muestre.
    expect(await page.evaluate("window.__typedPlace")).toBe(
      "Calle Inventada 1234, Ñuñoa, Región Metropolitana",
    );
    expect(await value("ubicacion")).toBe("Villa Ñuñoa, Santiago, Chile");
    expect(await page.locator("#estado-fotos").innerText()).toBe("Se han adjuntado 2 fotos");
    // Facebook sube las fotos DESPUÉS de adjuntarlas (2026-10-14: «¡Uy!» con
    // ERR_FILE_NOT_FOUND, porque se borraban del disco al terminar): tienen que poder leerse
    // después de que el llenado terminó.
    await expect
      .poll(() => page.evaluate("[window.__uploadOk, window.__uploadFailed]"), { timeout: 3_000 })
      .toEqual([2, undefined]);
    // Las fotos van por el control que acepta solo imágenes, no por el de imágenes y videos.
    expect(await page.evaluate("window.__uploadedVia")).toBe("fotos-arrastrar");
    // Solo el desplegable y sus opciones: nunca Siguiente, Publicar, el borrador ni los interruptores.
    expect(await page.locator("#siguiente").isDisabled()).toBe(true);
    const clicks = await clicksOf(t);
    expect(clicks).not.toContain("siguiente");
    expect(clicks).not.toContain("publicar");
    expect(clicks).toEqual(["combo-tipo", "Apartamento o piso", "Villa Ñuñoa, Santiago, Chile"]);
    // La ventana queda abierta y entregada; la cuenta vieja se cerró antes.
    expect(t.closedAccounts).toEqual(["acc-1"]);
    expect(t.handoffs.map((handoff) => handoff.ref)).toEqual([
      { publicationId: "pub-1", brokerId: "broker-1", accountId: "acc-1" },
    ]);
    expect(t.handoffs[0]?.window.isOpen()).toBe(true);
    // Evidencia solo del formulario; las fotos temporales, borradas.
    expect((await readdir(t.dir)).sort()).toEqual(["formulario.aria.yml", "formulario.png"]);
    const aria = await readFile(join(t.dir, "formulario.aria.yml"), "utf8");
    // Sin la barra de Facebook (el panel del formulario real sí trae el nombre del operador).
    expect(aria).not.toContain("mensajes");
    expect(aria).not.toContain("Búsquedas recientes");
    expect((await stat(t.dir)).mode & 0o777).toBe(0o700);
    expect(t.read).toEqual(input.media.map((media) => media.storagePath));
    await t.handoffs[0]?.window.close();
  });

  it("llena el formulario aunque las fotos vivan en un form aparte", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-foto-aparte.html" },
    });

    await expect(t.publisher.publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
    });

    const page = pageOf(t);
    expect(await page.locator('[name="precio"]').inputValue()).toBe("650000");
    expect(await page.locator("#estado-fotos").innerText()).toBe("Se han adjuntado 2 fotos");
    const aria = await readFile(join(t.dir, "formulario.aria.yml"), "utf8");
    expect(aria).toContain("Precio");
    await t.handoffs[0]?.window.close();
  });

  it("con dirección, la escribe tal cual (sin la unidad) y hace clic en la primera sugerencia, tenga o no la comuna", async () => {
    const t = await setup({
      routes: {
        ...DEFAULT_ROUTES,
        "/marketplace/create/rental": "form-sugerencia-sin-comuna.html",
      },
    });

    // `show_exact_address` es falso en `input`: igual se usa la dirección (D16).
    await t.publisher.publish(input, ctx);

    expect(await pageOf(t).evaluate("window.__typedPlace")).toBe(
      "Calle Inventada 1234, Ñuñoa, Región Metropolitana",
    );
    expect(t.reported).toHaveLength(3);
    // La primera, aunque no diga la comuna; no la segunda.
    expect(t.reported[2]).toMatch(/^Calle Inventada 1234/);
    await t.handoffs[0]?.window.close();
  });

  it("con dirección elige la primera sugerencia aunque otra sea de la comuna", async () => {
    const t = await setup({
      routes: {
        ...DEFAULT_ROUTES,
        "/marketplace/create/rental": "form-direccion-codigo-postal.html",
      },
    });

    await t.publisher.publish(input, ctx);

    // La primera de la lista (la misma calle en Maipú): la regla del operador es no comparar la comuna.
    expect(t.reported).toHaveLength(3);
    expect(t.reported[2]).toMatch(/^Calle Inventada 1234, 9250000 Maipú/);
    await t.handoffs[0]?.window.close();
  });
  it("si el clic en la sugerencia no se puede hacer (algo la tapa), elige con el teclado la primera sugerencia", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-sugerencias-tapadas.html" },
    });

    await expect(t.publisher.publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
    });

    const page = pageOf(t);
    // Bajó con la flecha una vez, vio que lo resaltado era la primera sugerencia y apretó Enter.
    expect(t.reported).toEqual([
      "combo-tipo",
      "Apartamento o piso",
      "teclado: Villa Ñuñoa, Santiago, Chile",
    ]);
    expect(await page.locator('[name="ubicacion"]').inputValue()).toBe(
      "Villa Ñuñoa, Santiago, Chile",
    );
    await t.handoffs[0]?.window.close();
  });

  it("si el clic no se puede hacer y la lista no dice cuál está resaltada, se detiene sin adivinar y dice por qué", async () => {
    const t = await setup({
      routes: {
        ...DEFAULT_ROUTES,
        "/marketplace/create/rental": "form-sugerencias-sin-resaltado.html",
      },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("no dice cuál sugerencia está resaltada"),
    });
    // Ni un clic ni un Enter: no adivinó.
    expect(t.reported).toEqual(["combo-tipo", "Apartamento o piso"]);
    expect(t.profiles[0]?.isOpen()).toBe(false);
    // Además del formulario, quedan las listas abiertas (viven fuera del formulario).
    expect(await readdir(t.dir)).toEqual(
      expect.arrayContaining(["control-faltante.aria.yml", "listas-abiertas.aria.yml"]),
    );
  });

  it("sin dirección y sin la comuna como entrada, usa una calle sin número de la comuna y lo avisa (caso real: Providencia)", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-comuna-en-calles.html" },
    });

    const result = await t.publisher.publish(withoutAddress, ctx);

    // Solo se escribió la comuna y la región, y se eligió la primera calle sin número de Ñuñoa.
    expect(await pageOf(t).evaluate("window.__typedPlace")).toBe("Ñuñoa, Región Metropolitana");
    // No la de Maipú ni la que lleva número.
    expect(t.reported).toEqual([
      "combo-tipo",
      "Apartamento o piso",
      "Avenida Ñuñoa, 7750000 Ñuñoa, Región Metropolitana de Santiago, Chile",
    ]);
    expect(result).toMatchObject({
      handoff: "manual_confirm",
      notes: [expect.stringContaining("una calle de Ñuñoa («Avenida Ñuñoa»)")],
    });
    await t.handoffs[0]?.window.close();
  });

  it("sin dirección, si la comuna aparece como entrada, la prefiere aunque una calle venga antes, y no avisa", async () => {
    const t = await setup({
      routes: {
        ...DEFAULT_ROUTES,
        "/marketplace/create/rental": "form-comuna-despues-de-calles.html",
      },
    });

    const result = await t.publisher.publish(withoutAddress, ctx);

    expect(t.reported).toEqual([
      "combo-tipo",
      "Apartamento o piso",
      "Ñuñoa, Región Metropolitana de Santiago, Chile",
    ]);
    expect(result).toEqual({ handoff: "manual_confirm", simulated: false });
    await t.handoffs[0]?.window.close();
  });

  it("sin dirección no elige una calle con número, aunque sea de la comuna", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-solo-calles.html" },
    });

    await expect(t.publisher.publish(withoutAddress, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("no sugirió la comuna"),
    });
    expect(t.reported).toEqual(["combo-tipo", "Apartamento o piso"]);
    expect(t.profiles[0]?.isOpen()).toBe(false);
  });
});

describe("publisher de Marketplace: ante un error (spec F5 §4.4)", () => {
  it("si un control no aparece, MARKETPLACE_FORM_CHANGED con la captura del formulario, y cierra", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-sin-precio.html" },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      retriable: false,
      message: expect.stringContaining("precio"),
    });

    expect(t.profiles[0]?.isOpen()).toBe(false);
    expect(t.handoffs).toEqual([]);
    expect(await readdir(t.dir)).toEqual(
      expect.arrayContaining(["control-faltante.aria.yml", "control-faltante.png"]),
    );
    // Las fotos nunca pasan por el disco.
    expect(await filesIn(t.dir)).not.toContain("fotos");
    // El perfil quedó libre: se puede volver a abrir.
    const again = await t.fb.open();
    await again.close();
  });

  it("si una opción no está en el desplegable, MARKETPLACE_FORM_CHANGED y no elige otra", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-sin-opcion.html" },
    });
    const listing = input.listing as NonNullable<PublishInput["listing"]>;

    await expect(
      t.publisher.publish({ ...input, listing: { ...listing, propertyType: "Casa" } }, ctx),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("«Casa»"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
  });

  it("un aviso en venta no abre nada: el formulario es solo de arriendo", async () => {
    const t = await setup();
    const listing = input.listing as NonNullable<PublishInput["listing"]>;

    await expect(
      t.publisher.publish({ ...input, listing: { ...listing, operation: "sale" } }, ctx),
    ).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      retriable: false,
      details: { issues: [expect.objectContaining({ code: "MARKETPLACE_OPERATION_UNSUPPORTED" })] },
    });
    // La simulación lo rechaza igual que en vivo.
    await expect(
      withDryRun(t.publisher).publish(
        { ...input, listing: { ...listing, operation: "sale" } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_INPUT_INVALID" });
    expect(t.read).toEqual([]);
    expect(t.profiles).toEqual([]);
  });

  it("nunca hace clic en un control que se llame como Siguiente o Publicar (NEVER_CLICK)", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-trampa.html" },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("botón de enviar"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
    // Se hicieron los clics del desplegable de tipo y nada más: la sugerencia «Publicar ahora…» y
    // los botones Siguiente y Publicar no se tocaron.
    expect(t.reported).toEqual(["combo-tipo", "Apartamento o piso"]);
  });

  it("en modo diagnóstico puede omitir la evidencia y las fotos, y entrega la pestaña para vigilarla", async () => {
    const seen: Array<{ dir: string }> = [];
    const t = await setup({
      deps: {
        fill: {
          pauseMs: 0,
          controlWaitMs: 1_000,
          photosWaitMs: 5_000,
          guardWaitMs: 1_000,
          skipPhotos: true,
        },
        diagnostics: {
          skipEvidence: true,
          watchPage: (_page, dir) => {
            seen.push({ dir });
          },
        },
      },
    });

    await expect(t.publisher.publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
    });

    const page = pageOf(t);
    expect(await page.locator("#estado-fotos").innerText()).toBe("Se han adjuntado 0 fotos");
    expect(seen).toEqual([{ dir: t.dir }]);
    // Ni captura ni árbol del formulario (y las fotos temporales, borradas).
    expect(await filesIn(t.dir)).toEqual([]);
    await t.handoffs[0]?.window.close();
  });

  it("si un control no responde, el error dice en qué paso falló y por qué", async () => {
    const t = await setup({
      routes: {
        ...DEFAULT_ROUTES,
        "/marketplace/create/rental": "form-descripcion-bloqueada.html",
      },
    });

    const error = await t.publisher.publish(input, ctx).catch((caught: Error) => caught);

    expect(error).toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringMatching(/paso «descripción» \(.*Timeout 1000ms/),
    });
    // Nada del aviso en el mensaje; la ventana se cerró y quedó la captura del formulario.
    expect((error as Error).message).not.toContain("Texto inventado");
    expect(t.profiles[0]?.isOpen()).toBe(false);
    expect(await readdir(t.dir)).toEqual(
      expect.arrayContaining(["control-faltante.aria.yml", "control-faltante.png"]),
    );
  });

  it("si el contador de fotos no existe, se detiene pronto en vez de esperar sin ver", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-sin-contador.html" },
      deps: { fill: { pauseMs: 0, controlWaitMs: 1_000, photosWaitMs: 800, guardWaitMs: 1_000 } },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("contador de fotos"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
    expect(t.handoffs).toEqual([]);
  });

  it("si el contador no sube, no da las fotos por cargadas", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-contador-fijo.html" },
      deps: { fill: { pauseMs: 0, controlWaitMs: 1_000, photosWaitMs: 800, guardWaitMs: 1_000 } },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("todas las fotos"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
  });

  it("sin dirección, una sugerencia que solo contiene la comuna («Villa Ñuñoa») no se elige", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-comuna-parecida.html" },
    });

    await expect(t.publisher.publish(withoutAddress, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("no sugirió la comuna"),
    });
    expect(t.reported).not.toContain("Villa Ñuñoa, Santiago, Chile");
  });

  it("si el campo de superficie pidiera metros, no escribe pies ahí", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-metros.html" },
    });

    await expect(t.publisher.publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
    });
    expect(await pageOf(t).locator('[name="pies"]').inputValue()).toBe("");
    await t.handoffs[0]?.window.close();
  });

  it("un corte (apagado del worker) a mitad del llenado cierra la ventana y lo dice", async () => {
    const t = await setup({ deps: { fill: { pauseMs: 300 } } });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 150);

    await expect(
      t.publisher.publish(input, { ...ctx, signal: abort.signal }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("se cortó"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
    expect(t.handoffs).toEqual([]);
  });

  it("con el corte antes de abrir, no abre la ventana", async () => {
    const t = await setup();
    const abort = new AbortController();
    abort.abort();

    await expect(
      t.publisher.publish(input, { ...ctx, signal: abort.signal }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_FORM_CHANGED" });
    expect(t.profiles).toEqual([]);
    expect(t.closedAccounts).toEqual([]);
  });

  it("ante el inicio de sesión se detiene sin captura y cierra la ventana", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "login-form.html" },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_SESSION_EXPIRED",
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
    expect(await filesIn(t.dir)).toEqual([]);
  });

  it("si R2 falla, no abre el navegador ni deja nada en el disco", async () => {
    const t = await setup({
      deps: {
        readPhoto: async () => {
          throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
        },
      },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retriable: true,
    });
    expect(t.profiles).toEqual([]);
    expect(t.closedAccounts).toEqual([]);
    expect(await filesIn(t.dir)).toEqual([]);
  });

  it("un tipo sin opción en Marketplace no baja fotos ni abre nada", async () => {
    const t = await setup();
    const listing = input.listing as NonNullable<PublishInput["listing"]>;

    await expect(
      t.publisher.publish({ ...input, listing: { ...listing, propertyType: "Bodega" } }, ctx),
    ).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      details: { issues: [expect.objectContaining({ code: "MARKETPLACE_TYPE_UNSUPPORTED" })] },
    });
    expect(t.read).toEqual([]);
    expect(t.profiles).toEqual([]);
  });

  it("si la entrega de la ventana falla, cierra la ventana", async () => {
    const t = await setup({
      deps: {
        onHandoff: async () => {
          throw new Error("el registro no respondió");
        },
      },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toThrow("el registro no respondió");
    expect(t.profiles[0]?.isOpen()).toBe(false);
  });

  it("con el perfil tomado espera a que se libere; si no, MARKETPLACE_PROFILE_BUSY", async () => {
    let tries = 0;
    const t = await setup({
      deps: {
        profileBusyWaitMs: 5_000,
        openProfile: async (brokerId) => {
          tries += 1;
          if (tries === 1) throw MARKETPLACE_ERRORS.profileBusy();
          const profile = await (facebook as FakeFacebook).open(brokerId);
          t.profiles.push(profile);
          return profile;
        },
      },
    });

    await expect(t.publisher.publish(input, ctx)).resolves.toMatchObject({
      handoff: "manual_confirm",
    });
    expect(tries).toBe(2);
    await t.handoffs[0]?.window.close();
  });

  it("si el perfil sigue tomado al tope, MARKETPLACE_PROFILE_BUSY", async () => {
    const t = await setup({
      deps: {
        openProfile: async () => {
          throw MARKETPLACE_ERRORS.profileBusy();
        },
      },
    });
    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_PROFILE_BUSY",
    });
    expect(await filesIn(t.dir)).toEqual([]);
  });

  it("al pasar su tope cierra la ventana y lo dice", async () => {
    const t = await setup({ deps: { maxMs: 50, fill: { pauseMs: 200 } } });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("tope de tiempo"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
  });
});
