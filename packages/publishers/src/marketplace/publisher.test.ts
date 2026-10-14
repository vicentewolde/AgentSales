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
  const read: string[] = [];
  const tmpRoot = join(fb.root, "tmp", "marketplace");
  const publisher = createMarketplacePublisher({
    openProfile: async (brokerId) => {
      const profile = await fb.open(brokerId);
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
  return { fb, publisher, handoffs, closedAccounts, profiles, read, dir, tmpRoot };
}

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
    expect(await page.locator("#combo-operacion").getAttribute("data-value")).toBe("Alquiler");
    expect(await page.locator("#combo-tipo").getAttribute("data-value")).toBe("Departamento");
    expect(await value("habitaciones")).toBe("2");
    expect(await value("banos")).toBe("1");
    expect(await value("precio")).toBe("650000");
    expect(await value("m2")).toBe("54");
    expect(await value("descripcion")).toBe("Texto inventado de Marketplace.");
    // Sin `show_exact_address`, la ubicación se busca por comuna y región, nunca por la dirección.
    expect(await page.evaluate("window.__typedPlace")).toBe("Ñuñoa, Región Metropolitana");
    expect(await value("ubicacion")).toBe("Ñuñoa, Santiago, Chile");
    expect(await page.locator("#miniaturas img").count()).toBe(2);
    // Solo los desplegables y sus opciones: nunca Siguiente ni Publicar.
    const clicks = await clicksOf(t);
    expect(clicks).not.toContain("siguiente");
    expect(clicks).not.toContain("publicar");
    expect(clicks).toEqual([
      "combo-operacion",
      "Alquiler",
      "combo-tipo",
      "Departamento",
      "Ñuñoa, Santiago, Chile",
    ]);
    // La ventana queda abierta y entregada; la cuenta vieja se cerró antes.
    expect(t.closedAccounts).toEqual(["acc-1"]);
    expect(t.handoffs.map((handoff) => handoff.ref)).toEqual([
      { publicationId: "pub-1", brokerId: "broker-1", accountId: "acc-1" },
    ]);
    expect(t.handoffs[0]?.window.isOpen()).toBe(true);
    // Evidencia solo del formulario; las fotos temporales, borradas.
    expect((await readdir(t.dir)).sort()).toEqual(["formulario.aria.yml", "formulario.png"]);
    const aria = await readFile(join(t.dir, "formulario.aria.yml"), "utf8");
    expect(aria).not.toContain("Nombre Inventado del Operador");
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
    expect(await page.locator("#miniaturas img").count()).toBe(2);
    const aria = await readFile(join(t.dir, "formulario.aria.yml"), "utf8");
    expect(aria).toContain("Precio");
    await t.handoffs[0]?.window.close();
  });

  it("con show_exact_address busca la dirección y la unidad", async () => {
    const t = await setup();
    const listing = { ...(input.listing as NonNullable<PublishInput["listing"]>) };

    await t.publisher.publish({ ...input, listing: { ...listing, showExactAddress: true } }, ctx);

    expect(await pageOf(t).evaluate("window.__typedPlace")).toBe("Calle Inventada 1234, 506");
    await t.handoffs[0]?.window.close();
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
    expect(await readdir(t.dir)).not.toContain("fotos");
    // El perfil quedó libre: se puede volver a abrir.
    const again = await t.fb.open();
    await again.close();
  });

  it("si una opción no está en el desplegable, MARKETPLACE_FORM_CHANGED y no elige otra", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-sin-venta.html" },
    });
    const listing = input.listing as NonNullable<PublishInput["listing"]>;

    await expect(
      t.publisher.publish({ ...input, listing: { ...listing, operation: "sale" } }, ctx),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("«Venta»"),
    });
    expect(t.profiles[0]?.isOpen()).toBe(false);
  });

  it("nunca hace clic en un control que se llame como Siguiente o Publicar (NEVER_CLICK)", async () => {
    const t = await setup({
      routes: { ...DEFAULT_ROUTES, "/marketplace/create/rental": "form-trampa.html" },
    });

    await expect(t.publisher.publish(input, ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_CHANGED",
      message: expect.stringContaining("botón de enviar"),
    });
    // Se cerró sin tocarla: la página registró los desplegables y nada más.
    expect(t.profiles[0]?.isOpen()).toBe(false);
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
    expect(await readdir(t.dir)).toEqual([]);
  });

  it("si R2 falla, no abre el navegador y borra las fotos", async () => {
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
    expect(await readdir(t.dir)).toEqual([]);
  });

  it("un tipo sin opción en Marketplace no baja fotos ni abre nada", async () => {
    const t = await setup();
    const listing = input.listing as NonNullable<PublishInput["listing"]>;

    await expect(
      t.publisher.publish({ ...input, listing: { ...listing, propertyType: "Bodega" } }, ctx),
    ).rejects.toMatchObject({ code: "MARKETPLACE_TYPE_UNSUPPORTED" });
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
    expect(await readdir(t.dir)).toEqual([]);
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
